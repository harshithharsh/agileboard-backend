import { Router } from 'express';
import { query } from '../config/db.js';
import { createJiraClient, jiraConfig, JiraConfigError } from '../jira/client.js';
import { lastSync, isSyncRunning, describeSyncError, SYNC_SINCE, SYNC_CLOSED_SPRINTS } from '../jira/sync.js';

// Settings → Integrations: how Jira and Redmine are connected (from the backend .env), and a live test.
// Secrets never leave the server: only whether a token or key is set.
const router = Router();
const TIMEOUT_MS = 20000;

const errorText = (err, name) => (err.name === 'TimeoutError' ? `${name} did not answer within ${TIMEOUT_MS / 1000} s` : describeSyncError(err).replace(/^Cannot reach Jira/, `Cannot reach ${name}`));

router.get('/admin/integrations', async (req, res, next) => {
  try {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, REDMINE_URL, REDMINE_API_KEY } = process.env;
    const [sync, counts] = await Promise.all([
      lastSync(),
      query(`SELECT (SELECT count(*)::int FROM projects WHERE status = 'active') AS projects,
                    (SELECT count(*)::int FROM teams) AS teams,
                    (SELECT count(*)::int FROM sprints) AS sprints`),
    ]);
    res.json({
      jira: {
        configured: !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN),
        baseUrl: JIRA_BASE_URL || null,
        email: JIRA_EMAIL || null,
        tokenSet: !!JIRA_API_TOKEN,
        syncSince: SYNC_SINCE,
        closedSprints: SYNC_CLOSED_SPRINTS,
        ...counts.rows[0],
        lastSync: sync.latest,
        lastSuccessAt: sync.lastSuccessAt,
        running: isSyncRunning(),
      },
      redmine: {
        configured: !!(REDMINE_URL && REDMINE_API_KEY),
        baseUrl: REDMINE_URL || null,
        keySet: !!REDMINE_API_KEY,
      },
    });
  } catch (err) { next(err); }
});

// Who the Jira token belongs to and how many projects it can see
router.post('/admin/integrations/jira/test', async (req, res) => {
  try {
    const jira = createJiraClient(jiraConfig());
    const [me, projects] = await Promise.all([jira.get('/rest/api/3/myself'), jira.get('/rest/api/3/project/search', { maxResults: 1 })]);
    res.json({ ok: true, account: me.displayName, timeZone: me.timeZone, projects: projects.total });
  } catch (err) {
    res.json({ ok: false, error: err instanceof JiraConfigError ? err.message : errorText(err, 'Jira') });
  }
});

// Who the Redmine API key belongs to, how many projects it can read, and whether it can list users
router.post('/admin/integrations/redmine/test', async (req, res) => {
  const { REDMINE_URL, REDMINE_API_KEY } = process.env;
  if (!REDMINE_URL || !REDMINE_API_KEY) return res.json({ ok: false, error: 'Redmine is not configured: set REDMINE_URL and REDMINE_API_KEY in the backend .env, then restart it' });
  const get = async (path) => {
    const r = await fetch(new URL(path, REDMINE_URL), { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: r.ok ? await r.json() : null };
  };
  try {
    const me = await get('/users/current.json');
    if (me.status === 401) return res.json({ ok: false, error: 'Redmine rejected the API key (401). Check REDMINE_API_KEY, and that the REST API is enabled in Redmine.' });
    if (!me.body) return res.json({ ok: false, error: `Redmine answered ${me.status} on /users/current.json` });
    const [projects, users] = await Promise.all([get('/projects.json?limit=1'), get('/users.json?limit=1')]);
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

export default router;
