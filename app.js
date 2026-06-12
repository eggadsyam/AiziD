import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';
import multer from 'multer';
import os from 'os';
import crypto from 'crypto';
import { google } from 'googleapis';

import { sequelize } from './db.js';
import { User, Account, FileCache, checkPasswordHash, generatePasswordHash } from './models.js';
import {
  getStorageQuota,
  listFiles,
  deleteFile as driveDelete,
  renameFile as driveRename,
  downloadFile as driveDownload,
  createFolder as driveCreateFolder,
  uploadFile as driveUploadFile,
  toggleStarred as driveToggleStarred,
  toggleShared as driveToggleShared,
  getDriveService
} from './driveService.js';
import {
  getTotalQuota,
  getMergedFiles,
  smartUpload,
  syncAllAccountsCache,
  detectDuplicateFiles,
  mergeGpartFiles
} from './aggregator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.enable('trust proxy');

// ============================================================
// Security Configurations & Helpers
// ============================================================

// HTTP Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Setup secure JWT secret
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'super-secret-jwt-key';
if (JWT_SECRET === 'super-secret-jwt-key' && process.env.NODE_ENV === 'production') {
  console.warn("WARNING: You are using the default JWT secret key in production! Please set JWT_SECRET_KEY in your environment.");
}

// In-memory rate limiting for login brute-force protection
const loginAttempts = {};
function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const attempts = loginAttempts[ip] || { count: 0, resetTime: 0 };
  
  const now = Date.now();
  if (attempts.resetTime > now) {
    const waitSeconds = Math.ceil((attempts.resetTime - now) / 1000);
    // Determine whether request is API or page
    if (req.path.startsWith('/api/')) {
      return res.status(429).json({ error: `Terlalu banyak percobaan masuk. Silakan coba lagi dalam ${waitSeconds} detik.` });
    }
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: `Terlalu banyak percobaan masuk. Silakan coba lagi dalam ${waitSeconds} detik.`,
      show_register_js: 'false'
    });
    return res.send(html);
  }
  next();
}

// Strong password validator
function validatePassword(password) {
  // Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special character
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return regex.test(password);
}

// Regex Escaper
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cookie Parser Helper
const parseCookies = (cookieHeader) => {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
};

// Custom Template Renderer (Jinja-compatible)
function renderTemplate(filePath, data = {}) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Custom simple Jinja2-like parsing for conditional blocks: {% if error %} ... {% endif %}
  const ifRegex = /\{%\s*if\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g;
  content = content.replace(ifRegex, (match, key, block) => {
    if (data[key]) {
      return block.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), data[key]);
    }
    return '';
  });

  // Handle standard {{ key }} replacements
  for (const key in data) {
    content = content.replace(new RegExp(escapeRegExp(`{{ ${key} }}`), 'g'), data[key])
                 .replace(new RegExp(escapeRegExp(`{{${key}}}`), 'g'), data[key]);
  }

  // Handle session.get('username') specifically
  if (data.username) {
    content = content.replace(/\{\{\s*session\.get\('username'\)\s*\}\}/g, data.username);
  }

  return content;
}

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Upload configurations
const upload = multer({ dest: os.tmpdir() });
const activeUploadsProgress = {};

// Read Google Client Secrets
const clientSecretPath = path.join(__dirname, 'client_secret_371845009482-fktit3komkb5p6ok8t397fg6rqjfvr4k.apps.googleusercontent.com.json');
let clientSecretConf = {};
try {
  const clientSecretData = JSON.parse(fs.readFileSync(clientSecretPath, 'utf8'));
  clientSecretConf = clientSecretData.web || clientSecretData.installed || {};
} catch (err) {
  console.error("Warning: Failed to load Google client_secret JSON. OAuth features may fail.", err.message);
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
];

const getRedirectUri = (req) => {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/oauth2callback`;
};

// ============================================================
// Auth Middleware
// ============================================================
function requireLogin(req, res, next) {
  const publicRoutes = ['/login', '/register', '/api/auth/login', '/api/auth/register'];
  const isPublic = req.path.startsWith('/static') || publicRoutes.includes(req.path);

  // Parse cookies to get the token
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.token;

  let decoded = null;
  if (token) {
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      req.user_id = parseInt(decoded.sub || decoded.id, 10);
      req.username = decoded.username || '';
    } catch (err) {
      // Invalidate expired/malformed tokens
      res.clearCookie('token');
    }
  }

  // Standalone Electron Client compatibility (auto-login local_user)
  const isElectron = req.headers['user-agent'] && req.headers['user-agent'].includes('Electron');
  if (isElectron) {
    req.user_id = 1;
    req.username = 'Local User';
    if (req.path === '/login') {
      return res.redirect('/');
    }
    return next();
  }

  if (decoded) {
    // Already authenticated, redirect away from login page
    if (req.path === '/login' || req.path === '/register') {
      return res.redirect('/');
    }
    return next();
  }

  // Not authenticated
  if (isPublic) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }
  
  res.redirect('/login');
}

app.use(requireLogin);

// Serve Static Files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Background Sync Helper (Asynchronous)
function startBackgroundSync(userId = null) {
  (async () => {
    try {
      const query = {};
      if (userId) query.user_id = userId;
      const accounts = await Account.findAll({ where: query });
      if (accounts.length > 0) {
        console.log(`Pemicu background sync dimulai untuk user ${userId}...`);
        await syncAllAccountsCache(accounts);
        console.log(`Background sync selesai untuk user ${userId}.`);
      }
    } catch (err) {
      console.error(`Background sync error: ${err.message}`);
    }
  })();
}

// Helper to sequentially pipe arrays of streams to a single output stream
function pipeSequentially(downloadFunctions, res) {
  const output = new PassThrough();
  output.pipe(res);

  let currentIndex = 0;

  function next() {
    if (currentIndex >= downloadFunctions.length) {
      output.end();
      return;
    }

    const getNextStream = downloadFunctions[currentIndex];
    getNextStream()
      .then(({ readStream, cleanUp }) => {
        readStream.pipe(output, { end: false });
        readStream.on('end', () => {
          cleanUp(); // Auto-cleanup temp file immediately
          currentIndex++;
          next();
        });
        readStream.on('error', (err) => {
          cleanUp();
          output.emit('error', err);
        });
      })
      .catch((err) => {
        output.emit('error', err);
      });
  }

  next();
  return output;
}

// ============================================================
// Routes — Pages & OAuth
// ============================================================

app.get('/', (req, res) => {
  const userId = req.user_id;
  const username = req.username || 'User';
  startBackgroundSync(userId);

  const html = renderTemplate(path.join(__dirname, 'templates', 'dashboard.html'), {
    username: username
  });
  res.send(html);
});

app.get('/login', (req, res) => {
  const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
    show_register_js: 'false'
  });
  res.send(html);
});

app.post('/login', rateLimitLogin, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const user = await User.findOne({ where: { username } });
    if (user && checkPasswordHash(user.password_hash, password)) {
      // Clear brute-force rate limiter on success
      delete loginAttempts[ip];

      const token = jwt.sign({ sub: String(user.id), username: user.username }, JWT_SECRET, { expiresIn: '1d' });
      
      // Send secure cookie
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 1 day
      });

      return res.redirect('/');
    }

    // Increment attempts on fail
    const attempts = loginAttempts[ip] || { count: 0, resetTime: 0 };
    attempts.count++;
    if (attempts.count >= 5) {
      attempts.resetTime = Date.now() + 15 * 60 * 1000; // 15 mins lock
      attempts.count = 0;
    }
    loginAttempts[ip] = attempts;

    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: 'Username atau password tidak cocok.',
      show_register_js: 'false'
    });
    res.send(html);
  } catch (err) {
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: `Terjadi kesalahan: ${err.message}`,
      show_register_js: 'false'
    });
    res.send(html);
  }
});

app.post('/register', async (req, res) => {
  const { username, password, confirm_password } = req.body || {};
  const cleanUsername = (username || '').trim();

  if (!cleanUsername || cleanUsername.length < 3) {
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: 'Username minimal terdiri dari 3 karakter.',
      show_register_js: 'true'
    });
    return res.send(html);
  }

  if (password !== confirm_password) {
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: 'Konfirmasi password tidak cocok.',
      show_register_js: 'true'
    });
    return res.send(html);
  }

  if (!validatePassword(password)) {
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: 'Password minimal 8 karakter, serta harus mengandung huruf besar, huruf kecil, angka, dan karakter khusus (@$!%*?&).',
      show_register_js: 'true'
    });
    return res.send(html);
  }

  try {
    const existing = await User.findOne({ where: { username: cleanUsername } });
    if (existing) {
      const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
        error: 'Username sudah terdaftar.',
        show_register_js: 'true'
      });
      return res.send(html);
    }

    await User.create({
      username: cleanUsername,
      password_hash: generatePasswordHash(password)
    });

    // Clear brute-force rate limit attempts on successful registration
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    delete loginAttempts[ip];

    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      message: 'Registrasi berhasil! Silakan masuk menggunakan akun baru Anda.',
      show_register_js: 'false'
    });
    res.send(html);
  } catch (err) {
    const html = renderTemplate(path.join(__dirname, 'templates', 'login.html'), {
      error: `Registrasi gagal: ${err.message}`,
      show_register_js: 'true'
    });
    res.send(html);
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

app.get('/add_account', (req, res) => {
  if (!clientSecretConf.client_id) {
    return res.status(500).send('Google Client secrets not loaded.');
  }

  const oauth2Client = new google.auth.OAuth2(
    clientSecretConf.client_id,
    clientSecretConf.client_secret,
    getRedirectUri(req)
  );

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  res.redirect(authorizationUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Callback authorization code is missing.');
  }

  const oauth2Client = new google.auth.OAuth2(
    clientSecretConf.client_id,
    clientSecretConf.client_secret,
    getRedirectUri(req)
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userinfo = await oauth2.userinfo.get();
    const email = userinfo.data.email;
    const name = userinfo.data.name || '';

    const userId = req.user_id;
    let existing = await Account.findOne({ where: { email, user_id: userId } });

    if (existing) {
      existing.access_token = tokens.access_token;
      if (tokens.refresh_token) {
        existing.refresh_token = tokens.refresh_token;
      }
      existing.token_uri = clientSecretConf.token_uri || 'https://oauth2.googleapis.com/token';
      existing.client_id = clientSecretConf.client_id;
      existing.client_secret = clientSecretConf.client_secret;
      existing.display_name = name;
      await existing.save();
    } else {
      await Account.create({
        user_id: userId,
        email,
        display_name: name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        token_uri: clientSecretConf.token_uri || 'https://oauth2.googleapis.com/token',
        client_id: clientSecretConf.client_id,
        client_secret: clientSecretConf.client_secret
      });
    }

    startBackgroundSync(userId);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.status(500).send(`Failed to connect Google Drive account: ${err.message}`);
  }
});

// ============================================================
// API Endpoints
// ============================================================

app.post('/api/auth/login', rateLimitLogin, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const user = await User.findOne({ where: { username } });
    if (user && checkPasswordHash(user.password_hash, password)) {
      delete loginAttempts[ip];
      const accessToken = jwt.sign({ sub: String(user.id), username: user.username }, JWT_SECRET, { expiresIn: '1d' });
      return res.json({ access_token: accessToken, username: user.username });
    }

    const attempts = loginAttempts[ip] || { count: 0, resetTime: 0 };
    attempts.count++;
    if (attempts.count >= 5) {
      attempts.resetTime = Date.now() + 15 * 60 * 1000;
      attempts.count = 0;
    }
    loginAttempts[ip] = attempts;

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = (username || '').trim();

  if (!cleanUsername || !password || password.length < 4) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }

  try {
    const existing = await User.findOne({ where: { username: cleanUsername } });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    await User.create({
      username: cleanUsername,
      password_hash: generatePasswordHash(password)
    });

    res.json({ success: true, message: 'Registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  const userId = req.user_id;
  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    res.json(accounts.map(a => a.toDict()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const userId = req.user_id;

  try {
    const account = await Account.findOne({ where: { id: accountId, user_id: userId } });
    if (account) {
      await FileCache.destroy({ where: { account_id: accountId, user_id: userId } });
      await account.destroy();
      startBackgroundSync(userId);
      return res.json({ success: true });
    }
    res.status(404).json({ error: 'Akun tidak ditemukan' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quota', async (req, res) => {
  const userId = req.user_id;
  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    if (accounts.length === 0) {
      return res.json({ total: 0, used: 0, free: 0, accounts: [] });
    }
    const result = await getTotalQuota(accounts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files', async (req, res) => {
  const folderId = req.query.folder_id || 'root';
  const accountId = req.query.account_id;
  const fileType = req.query.type; // 'shared' or 'starred'
  const userId = req.user_id;

  try {
    const where = { user_id: userId };
    if (fileType === 'starred') {
      where.is_starred = 1;
    } else if (fileType === 'shared') {
      where.is_shared = 1;
    } else {
      where.parent_id = folderId;
    }

    if (accountId) {
      where.account_id = parseInt(accountId, 10);
    }

    const files = await FileCache.findAll({ where });
    let serialized = files.map(f => f.toDict());
    serialized = mergeGpartFiles(serialized);

    serialized.sort((a, b) => {
      const aIsDir = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
      const bIsDir = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });

    res.json(serialized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  const queryStr = req.query.q || '';
  const userId = req.user_id;

  if (!queryStr) {
    return res.json([]);
  }

  try {
    const { Op } = sequelize.Sequelize;
    const files = await FileCache.findAll({
      where: {
        user_id: userId,
        name: {
          [Op.like]: `%${queryStr}%`
        }
      }
    });

    let serialized = files.map(f => f.toDict());
    serialized = mergeGpartFiles(serialized);

    serialized.sort((a, b) => {
      const aIsDir = a.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
      const bIsDir = b.mimeType === 'application/vnd.google-apps.folder' ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });

    res.json(serialized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  const userId = req.user_id;
  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    const success = await syncAllAccountsCache(accounts);
    if (success) {
      return res.json({ success: true });
    }
    res.status(500).json({ error: 'Sinkronisasi metadata gagal' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders/create', async (req, res) => {
  const { name: folderName, parent_id = 'root', account_id } = req.body || {};
  const userId = req.user_id;

  if (!folderName) {
    return res.status(400).json({ error: 'Nama folder diperlukan' });
  }

  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    if (accounts.length === 0) {
      return res.status(400).json({ error: 'Belum ada akun Google Drive terhubung' });
    }

    let targetAccount = null;
    if (account_id) {
      targetAccount = await Account.findOne({ where: { id: parseInt(account_id, 10), user_id: userId } });
    } else if (parent_id !== 'root') {
      const parentFolder = await FileCache.findOne({ where: { file_id: parent_id, user_id: userId } });
      if (parentFolder) {
        targetAccount = await Account.findOne({ where: { id: parentFolder.account_id, user_id: userId } });
      }
    }

    if (!targetAccount) {
      const spaces = [];
      for (const acc of accounts) {
        const quota = await getStorageQuota(acc);
        spaces.push({ acc, free: quota.total - quota.used });
      }
      spaces.sort((a, b) => b.free - a.free);
      targetAccount = spaces[0].acc;
    }

    const folder = await driveCreateFolder(targetAccount, folderName, parent_id);

    await FileCache.create({
      file_id: folder.id,
      name: folder.name,
      mime_type: 'application/vnd.google-apps.folder',
      size: 0,
      parent_id,
      account_id: targetAccount.id,
      user_id: userId,
      is_starred: 0,
      is_shared: 0
    });

    startBackgroundSync(userId);
    res.json({ success: true, folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/move', async (req, res) => {
  const { file_id, target_account_id } = req.body || {};
  const userId = req.user_id;

  if (!file_id || !target_account_id) {
    return res.status(400).json({ error: 'file_id dan target_account_id diperlukan' });
  }

  try {
    const fileMeta = await FileCache.findOne({ where: { file_id, user_id: userId } });
    if (!fileMeta) {
      return res.status(404).json({ error: 'File tidak terdaftar di cache' });
    }

    const sourceAccount = await Account.findOne({ where: { id: fileMeta.account_id, user_id: userId } });
    const targetAccount = await Account.findOne({ where: { id: parseInt(target_account_id, 10), user_id: userId } });

    if (!sourceAccount || !targetAccount) {
      return res.status(404).json({ error: 'Akun asal atau target tidak ditemukan' });
    }

    if (sourceAccount.id === targetAccount.id) {
      return res.status(400).json({ error: 'Akun asal dan target sama' });
    }

    const { readStream, filename, mimeType, cleanUp } = await driveDownload(sourceAccount, file_id);

    try {
      await driveUploadFile(targetAccount, readStream, filename, mimeType, 'root');
      await driveDelete(sourceAccount, file_id);

      await fileMeta.destroy();
      cleanUp();

      startBackgroundSync(userId);
      res.json({ success: true, message: `File berhasil dipindahkan ke ${targetAccount.email}` });
    } catch (innerErr) {
      cleanUp();
      throw innerErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/duplicates', async (req, res) => {
  const userId = req.user_id;
  try {
    const duplicates = await detectDuplicateFiles(userId);
    res.json(duplicates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Tidak ada file yang dikirim' });
  }

  const folderId = req.body.folder_id || 'root';
  const userId = req.user_id;

  const filename = file.originalname;
  activeUploadsProgress[filename] = {
    bytes_uploaded: 0,
    total_bytes: file.size,
    percentage: 0
  };

  const progressCallback = (bytesUploaded, totalBytes) => {
    const percentage = totalBytes ? (bytesUploaded / totalBytes) * 100 : 0;
    activeUploadsProgress[filename] = {
      bytes_uploaded: bytesUploaded,
      total_bytes: totalBytes,
      percentage: Math.round(percentage * 100) / 100
    };
  };

  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    if (accounts.length === 0) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Belum ada akun yang terhubung' });
    }

    const fileStream = fs.createReadStream(file.path);
    const result = await smartUpload(
      accounts,
      fileStream,
      filename,
      file.mimetype || 'application/octet-stream',
      file.size,
      folderId,
      progressCallback
    );

    if (result.success) {
      if (result.is_gpart) {
        for (const part of result.parts) {
          await FileCache.create({
            file_id: part.file.id,
            name: part.name,
            mime_type: file.mimetype || 'application/octet-stream',
            size: part.size,
            parent_id: folderId,
            account_id: part.account_id,
            user_id: userId,
            is_starred: 0,
            is_shared: 0
          });
        }
      } else {
        await FileCache.create({
          file_id: result.file.id,
          name: result.file.name,
          mime_type: file.mimetype || 'application/octet-stream',
          size: file.size,
          parent_id: folderId,
          account_id: result.account_id,
          user_id: userId,
          is_starred: 0,
          is_shared: 0
        });
      }
      startBackgroundSync(userId);
    }

    fs.unlink(file.path, (err) => {
      if (err) console.error(`Failed to delete multer upload temp file: ${file.path}`, err);
    });

    res.json(result);
  } catch (err) {
    console.error('Upload Error:', err);
    fs.unlink(file.path, () => {});
    res.status(500).json({ error: err.message });
  } finally {
    delete activeUploadsProgress[filename];
  }
});

app.get('/api/upload/progress', (req, res) => {
  const filename = req.query.filename;
  if (filename && activeUploadsProgress[filename]) {
    return res.json(activeUploadsProgress[filename]);
  }
  res.json({ percentage: 0, status: 'idle' });
});

app.delete('/api/delete/:file_id', async (req, res) => {
  const fileId = req.params.file_id;
  const accountId = req.query.account_id;
  const userId = req.user_id;

  try {
    if (fileId.startsWith('gpart:')) {
      const parts = fileId.split(':');
      if (parts.length < 3) {
        return res.status(400).json({ error: 'Format ID file virtual tidak valid' });
      }
      const parentId = parts[1];
      const baseName = parts.slice(2).join(':');

      const cachedParts = await FileCache.findAll({ where: { user_id: userId, parent_id: parentId } });
      const regex = new RegExp(`^${escapeRegExp(baseName)}\\.gpart\\.(\\d+)$`);
      const matchingParts = cachedParts.filter(p => regex.test(p.name));

      if (matchingParts.length === 0) {
        return res.status(404).json({ error: 'Bagian file tidak ditemukan di cache' });
      }

      for (const p of matchingParts) {
        const account = await Account.findOne({ where: { id: p.account_id, user_id: userId } });
        if (account) {
          try {
            await driveDelete(account, p.file_id);
          } catch (delErr) {
            console.error(`Gagal menghapus part ${p.name} dari Drive: ${delErr.message}`);
          }
        }
        await p.destroy();
      }
      startBackgroundSync(userId);
      return res.json({ success: true });

    } else {
      if (!accountId) {
        return res.status(400).json({ error: 'account_id diperlukan' });
      }
      const account = await Account.findOne({ where: { id: parseInt(accountId, 10), user_id: userId } });
      if (!account) {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
      }

      await driveDelete(account, fileId);
      await FileCache.destroy({ where: { file_id: fileId, user_id: userId } });
      startBackgroundSync(userId);
      return res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rename/:file_id', async (req, res) => {
  const fileId = req.params.file_id;
  const accountId = req.query.account_id;
  const { name: newName } = req.body || {};
  const userId = req.user_id;

  if (!newName) {
    return res.status(400).json({ error: 'name diperlukan' });
  }

  try {
    if (fileId.startsWith('gpart:')) {
      const parts = fileId.split(':');
      if (parts.length < 3) {
        return res.status(400).json({ error: 'Format ID file virtual tidak valid' });
      }
      const parentId = parts[1];
      const baseName = parts.slice(2).join(':');

      const cachedParts = await FileCache.findAll({ where: { user_id: userId, parent_id: parentId } });
      const regex = new RegExp(`^${escapeRegExp(baseName)}\\.gpart\\.(\\d+)$`);
      const matchingParts = cachedParts.filter(p => regex.test(p.name));

      if (matchingParts.length === 0) {
        return res.status(404).json({ error: 'Bagian file tidak ditemukan' });
      }

      matchingParts.sort((a, b) => {
        const aNum = parseInt(a.name.match(regex)[1], 10);
        const bNum = parseInt(b.name.match(regex)[1], 10);
        return aNum - bNum;
      });

      for (let i = 0; i < matchingParts.length; i++) {
        const p = matchingParts[i];
        const partNum = i + 1;
        const newPartName = `${newName}.gpart.${String(partNum).padStart(3, '0')}`;
        const account = await Account.findOne({ where: { id: p.account_id, user_id: userId } });
        
        if (account) {
          try {
            await driveRename(account, p.file_id, newPartName);
          } catch (renErr) {
            console.error(`Gagal me-rename part ${p.name} ke ${newPartName}: ${renErr.message}`);
          }
        }
        p.name = newPartName;
        await p.save();
      }

      startBackgroundSync(userId);
      return res.json({ success: true, name: newName });

    } else {
      if (!accountId) {
        return res.status(400).json({ error: 'account_id diperlukan' });
      }
      const account = await Account.findOne({ where: { id: parseInt(accountId, 10), user_id: userId } });
      if (!account) {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
      }

      const result = await driveRename(account, fileId, newName);
      const cacheItem = await FileCache.findOne({ where: { file_id: fileId, user_id: userId } });
      if (cacheItem) {
        cacheItem.name = newName;
        await cacheItem.save();
      }
      startBackgroundSync(userId);
      return res.json(result);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/files/star/:file_id', async (req, res) => {
  const fileId = req.params.file_id;
  const accountId = req.query.account_id;
  const { starred } = req.body || {};
  const userId = req.user_id;

  try {
    const isStarred = !!starred;

    if (fileId.startsWith('gpart:')) {
      const parts = fileId.split(':');
      if (parts.length < 3) {
        return res.status(400).json({ error: 'Format ID file virtual tidak valid' });
      }
      const parentId = parts[1];
      const baseName = parts.slice(2).join(':');

      const cachedParts = await FileCache.findAll({ where: { user_id: userId, parent_id: parentId } });
      const regex = new RegExp(`^${escapeRegExp(baseName)}\\.gpart\\.(\\d+)$`);
      const matchingParts = cachedParts.filter(p => regex.test(p.name));

      if (matchingParts.length === 0) {
        return res.status(404).json({ error: 'Bagian file tidak ditemukan' });
      }

      for (const p of matchingParts) {
        const account = await Account.findOne({ where: { id: p.account_id, user_id: userId } });
        if (account) {
          try {
            await driveToggleStarred(account, p.file_id, isStarred);
          } catch (err) {
            console.error(`Gagal men-starred part ${p.name}: ${err.message}`);
          }
        }
        p.is_starred = isStarred ? 1 : 0;
        await p.save();
      }
      startBackgroundSync(userId);
      return res.json({ success: true, starred: isStarred });

    } else {
      if (!accountId) {
        return res.status(400).json({ error: 'account_id diperlukan' });
      }
      const account = await Account.findOne({ where: { id: parseInt(accountId, 10), user_id: userId } });
      if (!account) {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
      }

      await driveToggleStarred(account, fileId, isStarred);
      const cacheItem = await FileCache.findOne({ where: { file_id: fileId, user_id: userId } });
      if (cacheItem) {
        cacheItem.is_starred = isStarred ? 1 : 0;
        await cacheItem.save();
      }
      startBackgroundSync(userId);
      return res.json({ success: true, starred: isStarred });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/files/share/:file_id', async (req, res) => {
  const fileId = req.params.file_id;
  const accountId = req.query.account_id;
  const { shared } = req.body || {};
  const userId = req.user_id;

  try {
    const isShared = !!shared;

    if (fileId.startsWith('gpart:')) {
      const parts = fileId.split(':');
      if (parts.length < 3) {
        return res.status(400).json({ error: 'Format ID file virtual tidak valid' });
      }
      const parentId = parts[1];
      const baseName = parts.slice(2).join(':');

      const cachedParts = await FileCache.findAll({ where: { user_id: userId, parent_id: parentId } });
      const regex = new RegExp(`^${escapeRegExp(baseName)}\\.gpart\\.(\\d+)$`);
      const matchingParts = cachedParts.filter(p => regex.test(p.name));

      if (matchingParts.length === 0) {
        return res.status(404).json({ error: 'Bagian file tidak ditemukan' });
      }

      for (const p of matchingParts) {
        const account = await Account.findOne({ where: { id: p.account_id, user_id: userId } });
        if (account) {
          try {
            await driveToggleShared(account, p.file_id, isShared);
          } catch (err) {
            console.error(`Gagal men-shared part ${p.name}: ${err.message}`);
          }
        }
        p.is_shared = isShared ? 1 : 0;
        await p.save();
      }
      startBackgroundSync(userId);
      return res.json({ success: true, shared: isShared });

    } else {
      if (!accountId) {
        return res.status(400).json({ error: 'account_id diperlukan' });
      }
      const account = await Account.findOne({ where: { id: parseInt(accountId, 10), user_id: userId } });
      if (!account) {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
      }

      await driveToggleShared(account, fileId, isShared);
      const cacheItem = await FileCache.findOne({ where: { file_id: fileId, user_id: userId } });
      if (cacheItem) {
        cacheItem.is_shared = isShared ? 1 : 0;
        await cacheItem.save();
      }
      startBackgroundSync(userId);
      return res.json({ success: true, shared: isShared });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/:file_id', async (req, res) => {
  const fileId = req.params.file_id;
  const accountId = req.query.account_id;
  const userId = req.user_id;

  try {
    if (fileId.startsWith('gpart:')) {
      const parts = fileId.split(':');
      if (parts.length < 3) {
        return res.status(400).json({ error: 'Format ID file virtual tidak valid' });
      }
      const parentId = parts[1];
      const baseName = parts.slice(2).join(':');

      const cachedParts = await FileCache.findAll({ where: { user_id: userId, parent_id: parentId } });
      const regex = new RegExp(`^${escapeRegExp(baseName)}\\.gpart\\.(\\d+)$`);
      const matchingParts = cachedParts.filter(p => regex.test(p.name));

      if (matchingParts.length === 0) {
        return res.status(404).json({ error: 'File tidak ditemukan' });
      }

      matchingParts.sort((a, b) => {
        const aNum = parseInt(a.name.match(regex)[1], 10);
        const bNum = parseInt(b.name.match(regex)[1], 10);
        return aNum - bNum;
      });

      const mapping = [];
      for (const p of matchingParts) {
        const account = await Account.findOne({ where: { id: p.account_id, user_id: userId } });
        if (!account) {
          return res.status(400).json({ error: `Akun Google Drive untuk file part '${p.name}' tidak dapat diakses.` });
        }
        try {
          getDriveService(account);
        } catch (accErr) {
          return res.status(400).json({ error: `Gagal mengakses akun ${account.email}: ${accErr.message}` });
        }
        mapping.push({ account, p });
      }

      const firstPart = matchingParts[0];
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}"`);
      res.setHeader('Content-Type', firstPart.mime_type || 'application/octet-stream');

      const downloadFuncs = mapping.map(({ account, p }) => {
        return () => driveDownload(account, p.file_id);
      });

      pipeSequentially(downloadFuncs, res);

    } else {
      if (!accountId) {
        return res.status(400).json({ error: 'account_id diperlukan' });
      }
      const account = await Account.findOne({ where: { id: parseInt(accountId, 10), user_id: userId } });
      if (!account) {
        return res.status(404).json({ error: 'Akun tidak ditemukan' });
      }

      const { readStream, filename, mimeType, cleanUp } = await driveDownload(account, fileId);
      
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      
      readStream.pipe(res);
      readStream.on('end', () => cleanUp());
      readStream.on('error', (err) => {
        cleanUp();
        console.error('Error downloading normal file:', err);
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug', async (req, res) => {
  const userId = req.user_id;
  try {
    const accounts = await Account.findAll({ where: { user_id: userId } });
    const results = [];

    for (const account of accounts) {
      const accResult = {
        email: account.email,
        has_refresh_token: !!account.refresh_token,
        has_access_token: !!account.access_token,
      };

      try {
        const { drive } = getDriveService(account);
        const aboutRes = await drive.about.get({ fields: 'storageQuota,user' });
        accResult.about_response = aboutRes.data;
        accResult.status = 'OK';
      } catch (err) {
        accResult.status = 'ERROR';
        accResult.error = err.message;
      }
      results.push(accResult);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { app };
export default app;
