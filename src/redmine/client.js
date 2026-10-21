// Minimal Redmine REST client (API key). Docs: https://www.redmine.org/projects/redmine/wiki/Rest_api

export class RedmineConfigError extends Error {}

export function redmineConfig() {
  const { REDMINE_URL, REDMINE_API_KEY } = process.env;
  if (!REDMINE_URL || !REDMINE_API_KEY) {
    throw new RedmineConfigError('Redmine is not configured: set REDMINE_URL and REDMINE_API_KEY in the backend .env, then restart it');
  }
  return { baseUrl: REDMINE_URL.replace(/\/$/, ''), key: REDMINE_API_KEY };
}

const PAGE = 100; // Redmine's maximum page size
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRedmineClient(config = redmineConfig()) {
  async function get(path, params = {}, attempt = 1) {
    const url = new URL(path, `${config.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { headers: { 'X-Redmine-API-Key': config.key, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      if (attempt <= 3) { await sleep(1000 * attempt); return get(path, params, attempt + 1); }
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
      await sleep(1000 * 2 ** attempt);
      return get(path, params, attempt + 1);
    }
    if (!res.ok) {
      const hint = res.status === 401 ? ' (Redmine rejected the API key)' : res.status === 403 ? ' (the API key has no access)' : '';
      throw new Error(`Redmine ${res.status} on ${url.pathname}${hint}`);
    }
    return res.json();
  }

  // All pages of a list endpoint, a few pages at a time
  async function getAll(path, params, key, { concurrency = 4, onPage } = {}) {
    const first = await get(path, { ...params, limit: PAGE, offset: 0 });
    const items = [...first[key]];
    const total = first.total_count ?? items.length;
    onPage?.(items.length, total);
    const offsets = [];
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
    for (let i = 0; i < offsets.length; i += concurrency) {
      const pages = await Promise.all(offsets.slice(i, i + concurrency).map((offset) => get(path, { ...params, limit: PAGE, offset })));
      for (const p of pages) items.push(...p[key]);
      onPage?.(items.length, total);
    }
    // Entries can shift between pages while paging; keep each id once
    return [...new Map(items.map((x) => [x.id, x])).values()];
  }

  return {
    get,
    projects: () => getAll('projects.json', {}, 'projects', { concurrency: 2 }),
    timeEntries: (projectId, { from, includeSubprojects = true, onPage }) =>
      getAll('time_entries.json', { project_id: projectId, from, ...(includeSubprojects ? {} : { subproject_id: '!*' }) }, 'time_entries', { onPage }),
  };
}
