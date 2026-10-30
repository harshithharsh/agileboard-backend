// Minimal Jira Cloud REST client (basic auth with an API token).
// Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
//       https://developer.atlassian.com/cloud/jira/software/rest/

import { jiraCredentials } from './credentials.js';

export class JiraConfigError extends Error {}

// Site from .env; email and token from Settings → Integrations → Jira if saved there, otherwise .env
export async function jiraConfig() {
  const { JIRA_BASE_URL } = process.env;
  const { email, token, unreadable } = await jiraCredentials();
  if (unreadable) {
    throw new JiraConfigError('The saved Jira API token can’t be read (SECRETS_KEY in the backend .env is missing or changed): enter the token again in Settings → Integrations → Jira');
  }
  if (!JIRA_BASE_URL || !email || !token) {
    throw new JiraConfigError('Jira is not configured: set JIRA_BASE_URL in .env, and the account email and API token in Settings → Integrations → Jira (or JIRA_EMAIL and JIRA_API_TOKEN in .env)');
  }
  return { baseUrl: JIRA_BASE_URL.replace(/\/$/, ''), email, token };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `config` from jiraConfig()
export function createJiraClient(config) {
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
        ? ' (Jira rejected the login: check the account email and that the API token is one valid token, pasted once)'
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
    // Active (not archived or trashed) projects, and the Scrum boards of one project
    projects: () => getAllPaged('/rest/api/3/project/search', { status: 'live', orderBy: 'name', expand: 'description' }, 'values'),
    // All boards of a project: Scrum boards have sprints; Kanban boards (e.g. chapters) only give members
    projectBoards: (projectKey) => getAllPaged('/rest/agile/1.0/board', { projectKeyOrId: projectKey }, 'values'),
    board: (boardId) => get(`/rest/agile/1.0/board/${boardId}`),
    // Issues on a board (its saved filter), only the fields asked for
    boardIssues: (boardId, jql, fields) =>
      getAllPaged(`/rest/agile/1.0/board/${boardId}/issue`, { jql, fields: fields.join(',') }, 'issues'),
    // expand=changelog returns at most 100 histories; fetch the rest when needed
    issueChangelog: (issueId) => getAllPaged(`/rest/api/3/issue/${issueId}/changelog`, {}, 'values'),
  };
}
