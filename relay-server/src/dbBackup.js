const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('node:crypto');

const BACKUP_MAGIC = Buffer.from('TALLYBK1', 'utf8');

function parseEncryptionKey(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  if (/^[A-Za-z0-9+/=]+$/.test(value)) {
    try {
      const asBase64 = Buffer.from(value, 'base64');
      if (asBase64.length === 32) return asBase64;
    } catch {
      // fall through to hash-based derivation
    }
  }

  return crypto.createHash('sha256').update(value).digest();
}

function utcTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeLabel(label) {
  return String(label || 'manual').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, iv, tag, encrypted]);
}

function decryptBuffer(buffer, key) {
  if (buffer.length <= BACKUP_MAGIC.length + 12 + 16) {
    throw new Error('Backup payload is too small to decrypt');
  }

  const magic = buffer.subarray(0, BACKUP_MAGIC.length);
  if (!magic.equals(BACKUP_MAGIC)) {
    throw new Error('Invalid backup format marker');
  }

  const ivStart = BACKUP_MAGIC.length;
  const tagStart = ivStart + 12;
  const dataStart = tagStart + 16;
  const iv = buffer.subarray(ivStart, tagStart);
  const tag = buffer.subarray(tagStart, dataStart);
  const ciphertext = buffer.subarray(dataStart);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function pruneBackups(backupDir, retainCount) {
  if (!Number.isFinite(retainCount) || retainCount <= 0) return [];

  const files = fs
    .readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite.gz') || name.endsWith('.sqlite.gz.enc'))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  for (const old of files.slice(retainCount)) {
    fs.unlinkSync(old.fullPath);
    removed.push(old.fullPath);
  }
  return removed;
}

function createBackupSnapshot(options) {
  const {
    dbPath,
    backupDir,
    encryptionKey,
    retainCount = 96,
    label = 'manual',
  } = options || {};

  if (!dbPath) throw new Error('dbPath is required');
  if (!fs.existsSync(dbPath)) throw new Error(`Database file not found: ${dbPath}`);

  const dbBuffer = fs.readFileSync(dbPath);
  const gzBuffer = zlib.gzipSync(dbBuffer, { level: 9 });
  const key = parseEncryptionKey(encryptionKey);

  ensureDir(backupDir);

  const baseName = `churches-${utcTimestamp()}-${sanitizeLabel(label)}.sqlite.gz`;
  const fileName = key ? `${baseName}.enc` : baseName;
  const fullPath = path.join(backupDir, fileName);
  const tmpPath = `${fullPath}.tmp`;

  const payload = key ? encryptBuffer(gzBuffer, key) : gzBuffer;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, fullPath);

  const removed = pruneBackups(backupDir, Number(retainCount));

  return {
    fullPath,
    encrypted: !!key,
    dbBytes: dbBuffer.length,
    backupBytes: payload.length,
    pruned: removed,
    createdAt: new Date().toISOString(),
  };
}

function restoreBackupSnapshot(options) {
  const {
    snapshotPath,
    destinationPath,
    encryptionKey,
    preserveExisting = true,
  } = options || {};

  if (!snapshotPath) throw new Error('snapshotPath is required');
  if (!destinationPath) throw new Error('destinationPath is required');
  if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot file not found: ${snapshotPath}`);

  const snapshot = fs.readFileSync(snapshotPath);
  const isEncrypted = snapshotPath.endsWith('.enc');

  let gzBuffer = snapshot;
  if (isEncrypted) {
    const key = parseEncryptionKey(encryptionKey);
    if (!key) throw new Error('BACKUP_ENCRYPTION_KEY is required to restore encrypted snapshots');
    gzBuffer = decryptBuffer(snapshot, key);
  }

  const dbBuffer = zlib.gunzipSync(gzBuffer);

  ensureDir(path.dirname(destinationPath));

  let replacedPath = null;
  if (preserveExisting && fs.existsSync(destinationPath)) {
    replacedPath = `${destinationPath}.pre-restore-${utcTimestamp()}`;
    fs.renameSync(destinationPath, replacedPath);
  }

  const tmpPath = `${destinationPath}.tmp`;
  fs.writeFileSync(tmpPath, dbBuffer);
  fs.renameSync(tmpPath, destinationPath);

  return {
    destinationPath,
    replacedPath,
    restoredBytes: dbBuffer.length,
    restoredAt: new Date().toISOString(),
    encrypted: isEncrypted,
  };
}

module.exports = {
  createBackupSnapshot,
  restoreBackupSnapshot,
  parseEncryptionKey,
};
