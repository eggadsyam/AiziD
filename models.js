import { DataTypes } from 'sequelize';
import crypto from 'crypto';
import sequelize from './db.js';

// ============================================================
// Model Definitions
// ============================================================

export const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    index: true
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'users'
});

export const Account = sequelize.define('Account', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    index: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false
  },
  display_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  access_token: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  refresh_token: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  token_uri: {
    type: DataTypes.STRING,
    allowNull: false
  },
  client_id: {
    type: DataTypes.STRING,
    allowNull: false
  },
  client_secret: {
    type: DataTypes.STRING,
    allowNull: false
  },
  quota_total: {
    type: DataTypes.DOUBLE,
    defaultValue: 0
  },
  quota_used: {
    type: DataTypes.DOUBLE,
    defaultValue: 0
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'accounts'
});

export const FileCache = sequelize.define('FileCache', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    index: true
  },
  file_id: {
    type: DataTypes.STRING,
    allowNull: false,
    index: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  mime_type: {
    type: DataTypes.STRING,
    allowNull: false
  },
  size: {
    type: DataTypes.DOUBLE,
    defaultValue: 0
  },
  modified_time: {
    type: DataTypes.STRING,
    allowNull: true
  },
  parent_id: {
    type: DataTypes.STRING,
    allowNull: false,
    index: true
  },
  account_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    index: true
  },
  is_starred: {
    type: DataTypes.INTEGER,
    defaultValue: 0 // 0 or 1
  },
  is_shared: {
    type: DataTypes.INTEGER,
    defaultValue: 0 // 0 or 1
  }
}, {
  tableName: 'file_cache'
});

// Relationships
User.hasMany(Account, { foreignKey: 'user_id', onDelete: 'CASCADE' });
Account.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(FileCache, { foreignKey: 'user_id', onDelete: 'CASCADE' });
FileCache.belongsTo(User, { foreignKey: 'user_id' });

// Add custom toDict/toJSON equivalents
User.prototype.toDict = function() {
  return {
    id: this.id,
    username: this.username,
    created_at: this.created_at ? this.created_at.toISOString() : null
  };
};

Account.prototype.toDict = function() {
  return {
    id: this.id,
    user_id: this.user_id,
    email: this.email,
    display_name: this.display_name || this.email,
    quota_total: this.quota_total,
    quota_used: this.quota_used,
    quota_free: this.quota_total - this.quota_used,
    created_at: this.created_at ? this.created_at.toISOString() : null
  };
};

FileCache.prototype.toDict = function() {
  return {
    id: this.file_id,
    name: this.name,
    mimeType: this.mime_type,
    size: this.size ? parseInt(this.size, 10) : 0,
    modifiedTime: this.modified_time,
    parent_id: this.parent_id,
    account_id: this.account_id,
    is_starred: !!this.is_starred,
    is_shared: !!this.is_shared
  };
};

// ============================================================
// Password Hashing Helpers (Flask PBKDF2 Compatible)
// ============================================================

export function checkPasswordHash(passwordHash, password) {
  if (!passwordHash) return false;
  // Flask default format: pbkdf2:sha256:iterations$salt$hash
  const parts = passwordHash.split('$');
  if (parts.length < 3) return false;

  const methodPart = parts[0];
  const salt = parts[1];
  const hash = parts[2];

  const methodSplit = methodPart.split(':');
  const method = methodSplit[0];
  const digest = methodSplit[1] || 'sha256';
  const iterations = parseInt(methodSplit[2] || '150000', 10);

  if (method !== 'pbkdf2') {
    return false;
  }

  // Key length for sha256 in hex format is length / 2
  const keylen = hash.length / 2;
  const derived = crypto.pbkdf2Sync(password, Buffer.from(salt, 'utf-8'), iterations, keylen, digest);
  return derived.toString('hex') === hash;
}

export function generatePasswordHash(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  const iterations = 600000;
  const digest = 'sha256';
  const keylen = 32;
  const derived = crypto.pbkdf2Sync(password, Buffer.from(salt, 'utf-8'), iterations, keylen, digest);
  const hash = derived.toString('hex');
  return `pbkdf2:sha256:${iterations}$${salt}$${hash}`;
}

// ============================================================
// DB Initialization
// ============================================================

export async function initDb() {
  // Sync schemas
  await sequelize.sync();

  // Create default user for standalone desktop mode
  const defaultUser = await User.findByPk(1);
  if (!defaultUser) {
    console.log("Membuat pengguna default lokal...");
    await User.create({
      id: 1,
      username: "local_user",
      password_hash: ""
    });
  }
}
