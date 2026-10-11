// Minimal Jira Cloud REST client (basic auth with an API token).
// Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
//       https://developer.atlassian.com/cloud/jira/software/rest/

export class JiraConfigError extends Error {}

export function jiraConfig() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new JiraConfigError('Jira is not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env');
  }
  return { baseUrl: JIRA_BASE_URL.replace(/\/$/, ''), email: JIRA_EMAIL, token: JIRA_API_TOKEN };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jira credentials: the active Jira API key from Admin (newest first), otherwise .env.
export async function resolveJiraConfig() {
  const { query } = await import('../config/db.js');
  const { decrypt } = await import('../lib/crypto.js');
  const { rows } = await query(
    `SELECT id, base_url, account_email, secret_encrypted FROM api_keys
      WHERE integration = 'jira' AND status = 'active' AND base_url IS NOT NULL AND account_email IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`
  );
  if (rows[0]) {
    const k = rows[0];
    return { baseUrl: k.base_url.replace(/\/$/, ''), email: k.account_email, token: decrypt(k.secret_encrypted), apiKeyId: k.id };
  }
  return jiraConfig();
}

export function createJiraClient(config = jiraConfig()) {
  const auth = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;

  async function get(path, params = {}, attempt = 1) {
    const url = new URL(path, config.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (res.status === 429 && attempt <= 5) {
      // Rate limited: honour Retry-After, otherwise back off exponentially
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      await sleep(wait);
      return get(path, params, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text();
      const hint = res.status === 401
        ? ' (Jira rejected the login: check JIRA_EMAIL and that JIRA_API_TOKEN is one valid token, pasted once)'
        : '';
      throw new Error(`Jira ${res.status} on ${url.pathname}${hint}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // Jira Agile endpoints page with startAt/maxResults/isLast (or total).
  async function getAllPaged(path, params, itemsKey) {
    const all = [];
    for (let startAt = 0; ; ) {
      const page = await get(path, { ...params, startAt, maxResults: 50 });
      const items = page[itemsKey] || [];
      all.push(...items);
      startAt += items.length;
      const done = page.isLast ?? (page.total === undefined || startAt >= page.total);
      if (done || !items.length) return all;
    }
  }

  return {
    get,
    fields: () => get('/rest/api/3/field'),
    statuses: () => get('/rest/api/3/status'),
    boardConfiguration: (boardId) => get(`/rest/agile/1.0/board/${boardId}/configuration`),
    boardSprints: (boardId) =>
      getAllPaged(`/rest/agile/1.0/board/${boardId}/sprint`, { state: 'active,closed' }, 'values'),
    sprintIssues: (sprintId, fields) =>
      getAllPaged(`/rest/agile/1.0/sprint/${sprintId}/issue`, { fields: fields.join(','), expand: 'changelog' }, 'issues'),
    // expand=changelog returns at most 100 histories; fetch the rest when needed
    issueChangelog: (issueId) => getAllPaged(`/rest/api/3/issue/${issueId}/changelog`, {}, 'values'),
  };
}
