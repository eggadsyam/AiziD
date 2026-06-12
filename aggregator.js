import fs from 'fs';
import path from 'path';
import os from 'os';
import { Op } from 'sequelize';
import sequelize from './db.js';
import { FileCache, Account } from './models.js';
import { getStorageQuota, listFiles, uploadFile, fetchAllFiles, getDriveService, deleteFile } from './driveService.js';

/**
 * Helper to extract a chunk of a specific size from a stream and write to a temporary file.
 * Automatically handles stream pausing and unshifting the remaining chunk back.
 */
async function extractStreamPart(fileStream, size, tempPath) {
  const writeStream = fs.createWriteStream(tempPath);
  let bytesWritten = 0;

  return new Promise((resolve, reject) => {
    function onData(chunk) {
      const remaining = size - bytesWritten;
      if (chunk.length <= remaining) {
        bytesWritten += chunk.length;
        writeStream.write(chunk);
        if (bytesWritten === size) {
          cleanup();
          resolve(bytesWritten);
        }
      } else {
        const part = chunk.slice(0, remaining);
        bytesWritten += part.length;
        writeStream.write(part);

        // Put the leftover back to the beginning of the stream
        fileStream.unshift(chunk.slice(remaining));
        cleanup();
        resolve(bytesWritten);
      }
    }

    function onEnd() {
      cleanup();
      resolve(bytesWritten);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      fileStream.removeListener('data', onData);
      fileStream.removeListener('end', onEnd);
      fileStream.removeListener('error', onError);
      writeStream.end();
    }

    fileStream.on('data', onData);
    fileStream.on('end', onEnd);
    fileStream.on('error', onError);
  });
}

/**
 * Get total merged storage quota of all connected accounts.
 */
export async function getTotalQuota(accounts) {
  let total = 0;
  let used = 0;
  const accountQuotas = [];

  for (const account of accounts) {
    try {
      const quota = await getStorageQuota(account);
      total += quota.total;
      used += quota.used;

      accountQuotas.push({
        account_id: account.id,
        email: quota.email,
        display_name: quota.display_name,
        total: quota.total,
        used: quota.used,
        free: quota.total - quota.used
      });

      // Update quota in database
      account.quota_total = quota.total;
      account.quota_used = quota.used;
      if (quota.display_name) {
        account.display_name = quota.display_name;
      }
      await account.save();
    } catch (e) {
      console.error(`Failed to fetch quota for account ${account.email}:`, e);
      accountQuotas.push({
        account_id: account.id,
        email: account.email,
        display_name: account.display_name || account.email,
        total: account.quota_total || 0,
        used: account.quota_used || 0,
        free: (account.quota_total || 0) - (account.quota_used || 0),
        error: e.message
      });
    }
  }

  return {
    total,
    used,
    free: total - used,
    accounts: accountQuotas
  };
}

/**
 * Fetch and merge lists of files from all accounts into one single virtual list.
 */
export async function getMergedFiles(accounts, folderId = 'root') {
  const merged = [];
  for (const account of accounts) {
    try {
      const files = await listFiles(account, folderId);
      merged.push(...files);
    } catch (e) {
      console.error(`Error listing files for account ${account.email}:`, e);
    }
  }

  // Sort: Folders first, then alphabetically by name
  merged.sort((a, b) => {
    const aIsDir = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    const bIsDir = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  });

  return merged;
}

/**
 * Groups split parts (*.gpart.NNN) into a single virtual merged file representation.
 */
export function mergeGpartFiles(filesList) {
  const pattern = /^(.*)\.gpart\.(\d+)$/;
  const groups = {}; // key: JSON.stringify([parent_id, base_name]) -> Array of parts
  const nonGparts = [];

  for (const f of filesList) {
    const match = f.name.match(pattern);
    if (match) {
      const baseName = match[1];
      const partNum = parseInt(match[2], 10);
      const parentId = f.parent_id;
      const key = JSON.stringify([parentId, baseName]);
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push({ partNum, file: f });
    } else {
      nonGparts.push(f);
    }
  }

  for (const key in groups) {
    const [parentId, baseName] = JSON.parse(key);
    const parts = groups[key];
    parts.sort((a, b) => a.partNum - b.partNum);

    const totalSize = parts.reduce((sum, p) => sum + (p.file.size || 0), 0);
    const modifiedTimes = parts.map(p => p.file.modifiedTime).filter(Boolean);
    const latestModified = modifiedTimes.length > 0 
      ? modifiedTimes.reduce((max, t) => t > max ? t : max, modifiedTimes[0])
      : null;

    const isStarred = parts.some(p => p.file.is_starred);
    const isShared = parts.some(p => p.file.is_shared);

    const firstPart = parts[0].file;
    const virtualId = `gpart:${parentId}:${baseName}`;

    nonGparts.push({
      id: virtualId,
      name: baseName,
      mimeType: firstPart.mimeType || 'application/octet-stream',
      size: parseInt(totalSize, 10),
      modifiedTime: latestModified || firstPart.modifiedTime,
      parent_id: parentId,
      account_id: firstPart.account_id,
      is_starred: isStarred,
      is_shared: isShared,
      is_gpart: true,
      parts: parts.map(p => p.file)
    });
  }

  return nonGparts;
}

/**
 * Upload files smartly into the account with the most free space.
 * If no single account fits the file, it splits it across multiple accounts.
 */
export async function smartUpload(accounts, fileStream, filename, mimeType, fileSize, folderId = 'root', progressCallback = null) {
  const accountSpaces = [];
  
  for (const account of accounts) {
    try {
      const quota = await getStorageQuota(account);
      const freeSpace = quota.total - quota.used;
      accountSpaces.push({ account, freeSpace, email: quota.email });
    } catch (e) {
      console.error(`Error checking quota for smartUpload on ${account.email}:`, e);
    }
  }

  // Sort by free space descending
  accountSpaces.sort((a, b) => b.freeSpace - a.freeSpace);

  // 1. Try uploading to a single account that fits the file
  for (const { account, freeSpace, email } of accountSpaces) {
    if (freeSpace >= fileSize) {
      const result = await uploadFile(account, fileStream, filename, mimeType, folderId, fileSize, progressCallback);
      return {
        success: true,
        file: result,
        uploaded_to: email,
        account_id: account.id
      };
    }
  }

  // 2. If no single account fits, split and upload across accounts (storage aggregation)
  const bufferSize = 10 * 1024 * 1024; // 10MB safe buffer per account
  const usableSpaces = [];
  let totalUsable = 0;

  for (const { account, freeSpace, email } of accountSpaces) {
    const usable = Math.max(0, freeSpace - bufferSize);
    if (usable > 0) {
      usableSpaces.push({ account, usable, email });
      totalUsable += usable;
    }
  }

  if (totalUsable < fileSize) {
    return {
      success: false,
      error: 'Tidak ada akun dengan ruang penyimpanan yang cukup untuk file ini.'
    };
  }

  // Allocate part sizes
  let remainingSize = fileSize;
  const allocations = [];
  for (const { account, usable, email } of usableSpaces) {
    if (remainingSize <= 0) break;
    const allocated = Math.min(remainingSize, usable);
    allocations.push({ account, allocatedSize: allocated, email });
    remainingSize -= allocated;
  }

  const uploadedParts = [];
  try {
    for (let i = 0; i < allocations.length; i++) {
      const { account, allocatedSize, email } = allocations[i];
      const partNum = i + 1;
      const partFilename = `${filename}.gpart.${String(partNum).padStart(3, '0')}`;

      // Create temporary file to hold the chunk
      const tempPath = path.join(os.tmpdir(), `gpart_chunk_${Date.now()}_part_${partNum}`);
      const written = await extractStreamPart(fileStream, allocatedSize, tempPath);

      if (written < allocatedSize) {
        throw new Error(`Unexpected EOF: expected ${allocatedSize} bytes, got ${written}`);
      }

      // Upload chunk to Drive
      const partStream = fs.createReadStream(tempPath);
      const partResult = await uploadFile(account, partStream, partFilename, mimeType, folderId, written, progressCallback);

      uploadedParts.push({
        account,
        file: partResult,
        name: partFilename,
        uploaded_to: email,
        account_id: account.id,
        size: written
      });

      // Cleanup chunk temp file
      fs.unlink(tempPath, (err) => {
        if (err) console.error(`Failed to delete chunk temp file: ${tempPath}`, err);
      });
    }

    return {
      success: true,
      is_gpart: true,
      parts: uploadedParts
    };

  } catch (err) {
    // Rollback: delete uploaded parts if something fails
    console.error(`Upload split file failed: ${err.message}. Rolling back...`);
    for (const part of uploadedParts) {
      try {
        await deleteFile(part.account, part.file.id);
      } catch (delErr) {
        console.error(`Failed to delete part ${part.name} during rollback:`, delErr);
      }
    }
    return {
      success: false,
      error: `Gagal mengupload file: ${err.message}`
    };
  }
}

/**
 * Synchronize cache entries inside Database with Google Drive metadata.
 */
export async function syncAllAccountsCache(accounts) {
  const transaction = await sequelize.transaction();
  try {
    const accountIds = accounts.map(acc => acc.id);
    if (accountIds.length > 0) {
      // Delete old cache for these accounts
      await FileCache.destroy({
        where: { account_id: accountIds },
        transaction
      });
    }

    for (const account of accounts) {
      try {
        // 1. Fetch & update storage quota
        const quota = await getStorageQuota(account);
        account.quota_total = quota.total;
        account.quota_used = quota.used;
        if (quota.display_name) {
          account.display_name = quota.display_name;
        }
        await account.save({ transaction });

        // Get actual Google Drive Root ID to normalize into alias 'root'
        const { drive } = getDriveService(account);
        let rootId = null;
        try {
          const rootRes = await drive.files.get({ fileId: 'root', fields: 'id' });
          rootId = rootRes.data.id;
        } catch (e) {
          console.error(`Failed to retrieve root folder ID for account ${account.email}:`, e);
        }

        // 2. Fetch all files bulk metadata
        const driveFiles = await fetchAllFiles(account);
        
        // Prepare bulk insert entries
        const cacheEntries = driveFiles.map(f => {
          const parents = f.parents || [];
          let parentId = parents[0] || 'root';
          if (rootId && parentId === rootId) {
            parentId = 'root';
          }

          return {
            file_id: f.id,
            name: f.name,
            mime_type: f.mimeType,
            size: f.size ? parseFloat(f.size) : 0.0,
            modified_time: f.modifiedTime,
            parent_id: parentId,
            account_id: account.id,
            user_id: account.user_id,
            is_starred: f.starred ? 1 : 0,
            is_shared: f.shared ? 1 : 0
          };
        });

        if (cacheEntries.length > 0) {
          await FileCache.bulkCreate(cacheEntries, { transaction });
        }
      } catch (innerErr) {
        console.error(`Failed to sync files for account ${account.email}:`, innerErr);
      }
    }

    await transaction.commit();
    return true;
  } catch (e) {
    await transaction.rollback();
    console.error('Fatal error during cache synchronization:', e);
    return false;
  }
}

/**
 * Detect duplicate files in the cached database (files with matching name and size).
 */
export async function detectDuplicateFiles(userId) {
  // Query to find name and size that appear more than once
  const dupQuery = await FileCache.findAll({
    attributes: ['name', 'size'],
    where: {
      user_id: userId,
      size: { [Op.gt]: 0 },
      mime_type: { [Op.ne]: 'application/vnd.google-apps.folder' }
    },
    group: ['name', 'size'],
    having: sequelize.literal('count(id) > 1'),
    raw: true
  });

  const duplicates = [];
  for (const dup of dupQuery) {
    const matchingFiles = await FileCache.findAll({
      where: {
        user_id: userId,
        name: dup.name,
        size: dup.size
      }
    });

    const fileList = [];
    for (const f of matchingFiles) {
      const acc = await Account.findByPk(f.account_id);
      const email = acc ? acc.email : 'Unknown';

      fileList.push({
        id: f.file_id,
        name: f.name,
        size: f.size ? parseInt(f.size, 10) : 0,
        modifiedTime: f.modified_time,
        account_id: f.account_id,
        account_email: email
      });
    }

    duplicates.push({
      name: dup.name,
      size: dup.size ? parseInt(dup.size, 10) : 0,
      items: fileList
    });
  }

  return duplicates;
}
