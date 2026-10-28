import { Router } from 'express';
import { query } from '../config/db.js';
import { createJiraClient, jiraConfig, JiraConfigError } from '../jira/client.js';
import { jiraCredentials, saveJiraCredentials, clearJiraCredentials } from '../jira/credentials.js';
import { redmineConfig } from '../redmine/client.js';
import { redmineCredentials, saveRedmineCredentials, clearRedmineCredentials } from '../redmine/credentials.js';
import { SecretsKeyError, SECRETS_KEY_MISSING } from '../config/secrets.js';
import { lastSync, isSyncRunning, describeSyncError, SYNC_SINCE, SYNC_CLOSED_SPRINTS } from '../jira/sync.js';

// Settings → Integrations: how Jira and Redmine are connected (credentials saved here, otherwise the
// backend .env), a live test, and changing the credentials. Secrets never leave the server: only whether a token or key is set.
const router = Router();
const TIMEOUT_MS = 20000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Where the credentials come from ('app' = saved in Settings, 'env' = backend .env) and who saved them;
// unreadable = saved, but SECRETS_KEY changed since
const credentialInfo = (c) => ({ source: c.source, unreadable: c.unreadable, updatedAt: c.updatedAt ?? null, updatedBy: c.updatedBy ?? null, canSave: !!process.env.SECRETS_KEY });

const errorText = (err, name) => (err.name === 'TimeoutError' ? `${name} did not answer within ${TIMEOUT_MS / 1000} s` : describeSyncError(err).replace(/^Cannot reach Jira/, `Cannot reach ${name}`));

router.get('/admin/integrations', async (req, res, next) => {
  try {
    const { JIRA_BASE_URL } = process.env;
    const [creds, redmine, sync, counts] = await Promise.all([
      jiraCredentials(),
      redmineCredentials(),
      lastSync(),
      query(`SELECT (SELECT count(*)::int FROM projects WHERE status = 'active') AS projects,
                    (SELECT count(*)::int FROM teams) AS teams,
                    (SELECT count(*)::int FROM sprints) AS sprints`),
    ]);
    res.json({
      jira: {
        configured: !!(JIRA_BASE_URL && creds.email && creds.token),
        baseUrl: JIRA_BASE_URL || null,
        email: creds.email,
        tokenSet: !!creds.token,
        ...credentialInfo(creds),
        syncSince: SYNC_SINCE,
        closedSprints: SYNC_CLOSED_SPRINTS,
        ...counts.rows[0],
        lastSync: sync.latest,
        lastSuccessAt: sync.lastSuccessAt,
        running: isSyncRunning(),
      },
      redmine: {
        configured: !!(redmine.url && redmine.key),
        baseUrl: redmine.url,
        keySet: !!redmine.key,
        ...credentialInfo(redmine),
      },
    });
  } catch (err) { next(err); }
});

// Who the Jira token belongs to and how many projects it can see
router.post('/admin/integrations/jira/test', async (req, res) => {
  try {
    const jira = createJiraClient(await jiraConfig());
    const [me, projects] = await Promise.all([jira.get('/rest/api/3/myself'), jira.get('/rest/api/3/project/search', { maxResults: 1 })]);
    res.json({ ok: true, account: me.displayName, timeZone: me.timeZone, projects: projects.total });
  } catch (err) {
    res.json({ ok: false, error: err instanceof JiraConfigError ? err.message : errorText(err, 'Jira') });
  }
});

// Change the Jira account email and API token. The new login is checked with Jira before it is saved.
// An empty token keeps the current one (e.g. to change only the email).
router.put('/admin/integrations/jira', async (req, res, next) => {
  const email = String(req.body?.email ?? '').trim();
  const newToken = String(req.body?.token ?? '').trim();
  if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter the email address of the Jira account the token belongs to' });
  if (!process.env.JIRA_BASE_URL) return res.status(400).json({ error: 'Set JIRA_BASE_URL in the backend .env first, then restart it' });
  if (!process.env.SECRETS_KEY) return res.status(400).json({ error: SECRETS_KEY_MISSING });
  try {
    const token = newToken || (await jiraCredentials()).token;
    if (!token) return res.status(400).json({ error: 'Enter the API token' });
    try {
      const jira = createJiraClient({ baseUrl: process.env.JIRA_BASE_URL.replace(/\/$/, ''), email, token });
      await jira.get('/rest/api/3/myself');
    } catch (err) {
      const rejected = /^Jira 40[13]/.test(err.message);
      return res.status(400).json({ error: rejected ? 'Jira rejected this email and token. Check that the token was created by this account and pasted once.' : `Could not check the token: ${errorText(err, 'Jira')}` });
    }
    await saveJiraCredentials({ email, token }, req.user.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof SecretsKeyError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Forget the saved email and token: back to JIRA_EMAIL / JIRA_API_TOKEN from the backend .env
router.delete('/admin/integrations/jira', async (req, res, next) => {
  try {
    await clearJiraCredentials();
    res.status(204).end();
  } catch (err) { next(err); }
});

// One Redmine GET with the given URL and key: { status, body }
async function redmineGet(baseUrl, key, path) {
  const r = await fetch(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), { headers: { 'X-Redmine-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: r.status, body: r.ok ? await r.json() : null };
}

// Who the Redmine API key belongs to, how many projects it can read, and whether it can list users
router.post('/admin/integrations/redmine/test', async (req, res) => {
  let config;
  try {
    config = await redmineConfig();
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
  const get = (path) => redmineGet(config.baseUrl, config.key, path);
  try {
    const me = await get('users/current.json');
    if (me.status === 401) return res.json({ ok: false, error: 'Redmine rejected the API key (401). Check the key, and that the REST API is enabled in Redmine.' });
    if (!me.body) return res.json({ ok: false, error: `Redmine answered ${me.status} on /users/current.json` });
    const [projects, users] = await Promise.all([get('projects.json?limit=1'), get('users.json?limit=1')]);
    res.json({
      ok: true,
      account: [me.body.user.firstname, me.body.user.lastname].filter(Boolean).join(' ') || me.body.user.login,
      login: me.body.user.login,
      projects: projects.body?.total_count ?? null,
      canListUsers: users.status === 200,
    });
  } catch (err) {
    res.json({ ok: false, error: errorText(err, 'Redmine') });
  }
});

// Change the Redmine URL and API key. They are checked with Redmine before they are saved.
// An empty key keeps the current one (e.g. to change only the URL).
router.put('/admin/integrations/redmine', async (req, res, next) => {
  const url = String(req.body?.url ?? '').trim().replace(/\/$/, '');
  const newKey = String(req.body?.key ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return res.status(400).json({ error: 'Enter the Redmine address, e.g. https://redmine.company.com' });
  if (!process.env.SECRETS_KEY) return res.status(400).json({ error: SECRETS_KEY_MISSING });
  try {
    const key = newKey || (await redmineCredentials()).key;
    if (!key) return res.status(400).json({ error: 'Enter the API key' });
    let me;
    try {
      me = await redmineGet(url, key, 'users/current.json');
    } catch (err) {
      return res.status(400).json({ error: `Could not check the key: ${errorText(err, 'Redmine')}` });
    }
    if (me.status === 401 || me.status === 403) return res.status(400).json({ error: 'Redmine rejected this API key. Check the key (My account → API access key), and that the REST API is enabled in Redmine.' });
    if (!me.body?.user) return res.status(400).json({ error: `Redmine answered ${me.status} on /users/current.json: check the address` });
    await saveRedmineCredentials({ url, key }, req.user.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof SecretsKeyError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Forget the saved URL and key: back to REDMINE_URL / REDMINE_API_KEY from the backend .env
router.delete('/admin/integrations/redmine', async (req, res, next) => {
  try {
    await clearRedmineCredentials();
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
