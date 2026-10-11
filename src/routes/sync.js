import { Router } from 'express';
import { syncFromJira, lastSync } from '../jira/sync.js';
import { JiraConfigError } from '../jira/client.js';
import { requirePermission } from '../auth/middleware.js';

const router = Router();

router.get('/sync', async (req, res, next) => {
  try {
    res.json(await lastSync());
  } catch (err) { next(err); }
});

// Pull the latest data from Jira (used by the dashboard's Refresh button)
router.post('/sync', requirePermission('edit'), async (req, res, next) => {
  try {
    const result = await syncFromJira({ log: () => {} });
    res.json({ ...result, ...(await lastSync()) });
  } catch (err) {
    if (err instanceof JiraConfigError) return res.status(503).json({ error: err.message });
    if (/^Jira \d+/.test(err.message)) return res.status(502).json({ error: err.message });
    // Network problems (no internet, DNS, VPN, timeouts) show up as "fetch failed" with a cause code
    const code = err.cause?.code;
    if (err.message === 'fetch failed' || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      const host = err.cause?.hostname ? ` (${err.cause.hostname})` : '';
      return res.status(502).json({ error: `Cannot reach Jira${host}: ${code || 'network error'}. Check your internet connection or VPN` });
    }
    next(err);
  }
});

export default router;
