import { loadCredentials, saveCredentials, clearCredentials } from '../config/secrets.js';

// Redmine URL and API key saved by an administrator in Settings → Integrations → Redmine,
// used instead of REDMINE_URL / REDMINE_API_KEY from .env. The key is stored encrypted.
const SETTING = 'redmine_credentials';

// URL and key to use: saved here first, otherwise .env. `unreadable` = a key is saved but can't be decrypted.
export async function redmineCredentials() {
  const saved = await loadCredentials(SETTING, 'key');
  if (saved) return { ...saved, source: 'app' };
  const { REDMINE_URL, REDMINE_API_KEY } = process.env;
  return { url: REDMINE_URL || null, key: REDMINE_API_KEY || null, source: REDMINE_URL || REDMINE_API_KEY ? 'env' : null, unreadable: false };
}

export const saveRedmineCredentials = ({ url, key }, userId) => saveCredentials(SETTING, 'key', { url, key }, userId);

// Back to REDMINE_URL / REDMINE_API_KEY from .env
export const clearRedmineCredentials = () => clearCredentials(SETTING);
