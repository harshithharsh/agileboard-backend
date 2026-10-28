import crypto from 'node:crypto';
import { query } from './db.js';

// Integration credentials saved by an administrator in Settings → Integrations (Jira, Redmine).
// Kept in app_settings as JSON; the secret part is encrypted (AES-256-GCM) with a key derived from
// SECRETS_KEY in the backend .env, so a database dump alone does not reveal it.

export class SecretsKeyError extends Error {}

export const SECRETS_KEY_MISSING = 'Set SECRETS_KEY in the backend .env (any long random string) and restart it before saving a token here';

function cipherKey() {
  if (!process.env.SECRETS_KEY) throw new SecretsKeyError(SECRETS_KEY_MISSING);
  return crypto.createHash('sha256').update(process.env.SECRETS_KEY).digest();
}

// 'v1:<iv>:<tag>:<data>', all base64
export function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join(':');
}

// null when it can't be read (SECRETS_KEY missing or changed since it was saved)
export function decryptSecret(blob) {
  try {
    const [version, iv, tag, data] = blob.split(':');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// The saved setting with its secret field decrypted:
// { ...value, [secretField]: plain text | null, unreadable, updatedAt, updatedBy } | null
export async function loadCredentials(key, secretField) {
  const { rows } = await query(
    `SELECT s.value, s.updated_at, u.name AS updated_by FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = $1`,
    [key]
  );
  if (!rows[0]) return null;
  const secret = decryptSecret(rows[0].value[secretField] ?? '');
  return { ...rows[0].value, [secretField]: secret, unreadable: !secret, updatedAt: rows[0].updated_at, updatedBy: rows[0].updated_by };
}

export async function saveCredentials(key, secretField, value, userId) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify({ ...value, [secretField]: encryptSecret(value[secretField]) }), userId]
  );
}

export async function clearCredentials(key) {
  await query('DELETE FROM app_settings WHERE key = $1', [key]);
}
