import { Router } from 'express';
import { getDashboard, getFilters } from '../services/dashboard.js';

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

// Dropdown options for the filter bar
router.get('/filters', async (req, res, next) => {
  try {
    res.json(await getFilters());
  } catch (err) { next(err); }
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Full dashboard for one team, or for all of a project's teams combined.
// Query: teamId (one team) or projectId (all teams), sprintId (default: latest; in the all-teams view
// this is the period's start date, YYYY-MM-DD), assigneeId, range (1–6 sprints for trend charts)
router.get('/dashboard', async (req, res, next) => {
  const { teamId, projectId, sprintId, assigneeId, range } = req.query;
  if (!UUID.test(teamId || '') && !UUID.test(projectId || '')) {
    return res.status(400).json({ error: 'teamId or projectId is required' });
  }
  if (assigneeId && !UUID.test(assigneeId)) return res.status(400).json({ error: 'assigneeId is not a valid id' });
  if (sprintId && !(teamId ? UUID : DATE).test(sprintId)) return res.status(400).json({ error: 'sprintId is not valid' });
  try {
    const data = await getDashboard({
      teamId: teamId || null, projectId, sprintId, assigneeId, range: range ? Number(range) : undefined,
    });
    if (!data) return res.status(404).json({ error: 'No sprints found for this team' });
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
