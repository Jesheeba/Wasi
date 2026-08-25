// Original MVP secret storage (see ../encryption.js's module comment for
// the full picture): AES-256-GCM with a server-held key derived from
// SERVER_SECRET. NOT a substitute for real KMS/Vault — the key still lives
// on the app server, in this process's own environment. This is the
// default backend (SECRET_STORE unset or 'env') and its behavior here is
// byte-for-byte unchanged from before encryption.js became pluggable.
const crypto = require('crypto');

function getKey() {
  const secret = process.env.SERVER_SECRET;
  if (!secret) throw new Error('SERVER_SECRET is not set (see .env.example)');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
