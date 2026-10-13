import { Router } from 'express';
import { syncFromJira, lastSync, isSyncRunning } from '../jira/sync.js';
import { requirePermission } from '../auth/middleware.js';

const router = Router();

// Status of the latest sync: { latest: { status: running | success | failed, message, ... }, lastSuccessAt }
router.get('/sync', async (req, res, next) => {
  try {
    res.json({ ...(await lastSync()), running: isSyncRunning() });
  } catch (err) { next(err); }
});

// Start a Jira sync (the dashboard's Refresh button). A full sync takes a minute or more, longer than
// hosting proxies keep a request open (Hostinger's CDN gives up after 60 s), so it runs in the background:
// this answers 202 straight away and the dashboard polls GET /api/sync until it has finished.
router.post('/sync', requirePermission('edit'), async (req, res, next) => {
  try {
    const alreadyRunning = isSyncRunning();
    if (!alreadyRunning) {
      syncFromJira({ log: () => {} }).catch((err) => console.error('Jira sync failed:', err.message));
    }
    res.status(202).json({ started: !alreadyRunning, running: true });
  } catch (err) { next(err); }
});

export default router;
