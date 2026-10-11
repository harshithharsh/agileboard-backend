import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM encryption for secrets stored in the database (API keys).
// The key is derived from APP_SECRET in .env; stored format: base64(iv | auth tag | ciphertext).

function key() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET is not set in .env; it is needed to store API keys securely');
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(stored) {
  const raw = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
