import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Get Google Drive API service client for an account.
 * Automatically refreshes access token using refresh token and saves it.
 */
export function getDriveService(account) {
  const oauth2Client = new google.auth.OAuth2(
    account.client_id,
    account.client_secret,
    account.token_uri
  );
  
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token
  });

  // Automatically save new access tokens when they are refreshed
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      account.access_token = tokens.access_token;
      account.save().catch(err => {
        console.error(`Failed to auto-update access token for ${account.email}:`, err);
      });
    }
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  return { drive, oauth2Client };
}

/**
 * Get storage quota info for a single account.
 */
export async function getStorageQuota(account) {
  const { drive } = getDriveService(account);
  const res = await drive.about.get({ fields: 'storageQuota,user' });
  const quota = res.data.storageQuota || {};
  const user = res.data.user || {};
  return {
    total: parseInt(quota.limit || '0', 10),
    used: parseInt(quota.usage || '0', 10),
    email: user.emailAddress || '',
    display_name: user.displayName || ''
  };
}

/**
 * Get list of files/folders in a folder.
 */
export async function listFiles(account, folderId = 'root', pageSize = 100) {
  const { drive } = getDriveService(account);
  const query = `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({
    q: query,
    pageSize: pageSize,
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, iconLink, thumbnailLink, webViewLink)',
    orderBy: 'folder,name'
  });
  
  const files = res.data.files || [];
  return files.map(f => ({
    ...f,
    account_id: account.id,
    account_email: account.email
  }));
}

/**
 * Upload a file stream to Google Drive.
 */
export async function uploadFile(account, fileStream, filename, mimeType, folderId = 'root', fileSize = null, progressCallback = null) {
  const { drive } = getDriveService(account);
  
  const requestBody = {
    name: filename,
    parents: [folderId]
  };

  const media = {
    mimeType: mimeType,
    body: fileStream
  };

  const uploadOptions = {};
  if (fileSize && progressCallback) {
    uploadOptions.onUploadProgress = (evt) => {
      progressCallback(evt.bytesRead, fileSize);
    };
  }

  const res = await drive.files.create({
    requestBody,
    media,
    fields: 'id, name, size'
  }, uploadOptions);

  return res.data;
}

/**
 * Delete a file/folder from Google Drive.
 */
export async function deleteFile(account, fileId) {
  const { drive } = getDriveService(account);
  await drive.files.delete({ fileId });
}

/**
 * Rename a file/folder in Google Drive.
 */
export async function renameFile(account, fileId, newName) {
  const { drive } = getDriveService(account);
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name'
  });
  return res.data;
}

/**
 * Download a file from Google Drive (handles Google Docs exports and streaming).
 */
export async function downloadFile(account, fileId) {
  const { drive } = getDriveService(account);
  
  // Get metadata first
  const metaRes = await drive.files.get({ fileId, fields: 'name, mimeType' });
  const mimeType = metaRes.data.mimeType || '';
  let filename = metaRes.data.name || 'download';
  
  const googleExportMap = {
    'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
    'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
    'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' }
  };

  let downloadRes;
  if (googleExportMap[mimeType]) {
    const exportMeta = googleExportMap[mimeType];
    downloadRes = await drive.files.export({
      fileId,
      mimeType: exportMeta.mime
    }, { responseType: 'stream' });
    
    if (!filename.endsWith(exportMeta.ext)) {
      filename += exportMeta.ext;
    }
  } else {
    downloadRes = await drive.files.get({
      fileId,
      alt: 'media'
    }, { responseType: 'stream' });
  }

  // Create temporary file path
  const tempPath = path.join(os.tmpdir(), `gabungin_${Date.now()}_${Math.random().toString(36).substring(2)}`);
  const writeStream = fs.createWriteStream(tempPath);
  
  await new Promise((resolve, reject) => {
    downloadRes.data.pipe(writeStream);
    downloadRes.data.on('error', reject);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  const readStream = fs.createReadStream(tempPath);
  const cleanUp = () => {
    fs.unlink(tempPath, (err) => {
      if (err) console.error(`Failed to delete temporary file: ${tempPath}`, err);
    });
  };

  return { readStream, filename, mimeType, cleanUp };
}

/**
 * Fetch all files and folders from Google Drive recursively (bulk request).
 */
export async function fetchAllFiles(account) {
  const { drive } = getDriveService(account);
  const query = 'trashed = false';
  const files = [];
  let pageToken = null;
  
  do {
    const res = await drive.files.list({
      q: query,
      pageSize: 1000,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, starred, shared)',
      pageToken: pageToken
    });
    
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  
  return files;
}

/**
 * Create a new folder.
 */
export async function createFolder(account, folderName, parentId = 'root') {
  const { drive } = getDriveService(account);
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id, name'
  });
  return res.data;
}

/**
 * Star / unstar a file.
 */
export async function toggleStarred(account, fileId, starred) {
  const { drive } = getDriveService(account);
  await drive.files.update({
    fileId,
    requestBody: { starred: starred },
    fields: 'id, starred'
  });
}

/**
 * Toggle file sharing (public reader access).
 */
export async function toggleShared(account, fileId, shared) {
  const { drive } = getDriveService(account);
  if (shared) {
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: 'anyone',
        role: 'reader'
      },
      fields: 'id'
    });
  } else {
    const res = await drive.permissions.list({ fileId, fields: 'permissions(id, type)' });
    const permissions = res.data.permissions || [];
    for (const perm of permissions) {
      if (perm.type === 'anyone') {
        await drive.permissions.delete({ fileId, permissionId: perm.id });
      }
    }
  }
}
