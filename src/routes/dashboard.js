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

// Full dashboard for one team and sprint.
// Query: teamId (required), quarter (financial year, e.g. FY2026-Q3 = Oct–Dec 2026: trend charts show that quarter's sprints),
// sprintId (default: latest, within the quarter if given), assigneeId
// Older frontends send calendar quarters ('2026-Q4' = Oct–Dec 2026): convert to the financial-year
// quarter covering the same months ('FY2026-Q3'), so a frontend deployed before the backend still works
export function normalizeQuarter(quarter) {
  if (!quarter || /^FY\d{4}-Q[1-4]$/.test(quarter)) return quarter || null;
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return undefined;
  const year = Number(m[1]), q = Number(m[2]);
  return q === 1 ? `FY${year - 1}-Q4` : `FY${year}-Q${q - 1}`;
}

router.get('/dashboard', async (req, res, next) => {
  const { teamId, sprintId, assigneeId } = req.query;
  const quarter = normalizeQuarter(req.query.quarter);
  if (quarter === undefined) return res.status(400).json({ error: 'quarter must look like FY2026-Q3' });
  if (!UUID.test(teamId || '')) return res.status(400).json({ error: 'teamId is required' });
  for (const [name, value] of Object.entries({ sprintId, assigneeId })) {
    if (value && !UUID.test(value)) return res.status(400).json({ error: `${name} is not a valid id` });
  }
  try {
    const data = await getDashboard({ teamId, sprintId, assigneeId, quarter });
    if (!data) return res.status(404).json({ error: 'No sprints found for this team' });
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
