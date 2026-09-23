import { Router } from 'express';
import { syncFromJira, lastSync } from '../jira/sync.js';
import { JiraConfigError } from '../jira/client.js';

const router = Router();

router.get('/sync', async (req, res, next) => {
  try {
    res.json(await lastSync());
  } catch (err) { next(err); }
});

// Pull the latest data from Jira (used by the dashboard's Refresh button)
router.post('/sync', async (req, res, next) => {
  try {
    const result = await syncFromJira({ log: () => {} });
    res.json({ ...result, ...(await lastSync()) });
  } catch (err) {
    if (err instanceof JiraConfigError) return res.status(503).json({ error: err.message });
    if (/^Jira \d+/.test(err.message)) return res.status(502).json({ error: err.message });
    next(err);
  }
});

export default router;
