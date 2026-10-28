import { loadCredentials, saveCredentials, clearCredentials } from '../config/secrets.js';

// Jira account email and API token saved by an administrator in Settings → Integrations → Jira,
// used instead of JIRA_EMAIL / JIRA_API_TOKEN from .env. The token is stored encrypted.
const SETTING = 'jira_credentials';

// Email and token to sign in to Jira with: saved here first, otherwise .env.
// `unreadable` = a token is saved but can't be decrypted.
export async function jiraCredentials() {
  const saved = await loadCredentials(SETTING, 'token');
  if (saved) return { ...saved, source: 'app' };
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  return { email: JIRA_EMAIL || null, token: JIRA_API_TOKEN || null, source: JIRA_EMAIL || JIRA_API_TOKEN ? 'env' : null, unreadable: false };
}

export const saveJiraCredentials = ({ email, token }, userId) => saveCredentials(SETTING, 'token', { email, token }, userId);

// Back to JIRA_EMAIL / JIRA_API_TOKEN from .env
export const clearJiraCredentials = () => clearCredentials(SETTING);
