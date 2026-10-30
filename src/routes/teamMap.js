import { Router } from 'express';
import { query } from '../config/db.js';

// Team Map: each active project with its squads and their members (from Jira, or added in Settings).
// Everyone signed in can see it.
const router = Router();

router.get('/team-map', async (req, res, next) => {
  try {
    const [projects, squads, members, allocations] = await Promise.all([
      query(`SELECT p.id, p.key, p.name, (SELECT u.name FROM users u WHERE u.id = p.manager_id) AS manager
               FROM projects p WHERE p.status = 'active' ORDER BY p.name`),
      query(`SELECT t.id, t.project_id, t.name, t.jira_board_id,
                    (SELECT count(*)::int FROM sprints s WHERE s.team_id = t.id) AS sprints
               FROM teams t JOIN projects p ON p.id = t.project_id WHERE p.status = 'active'
              ORDER BY (SELECT count(*) FROM sprints s WHERE s.team_id = t.id) = 0, t.name`),
      query(`SELECT tm.team_id, u.id, u.name, u.email, r.name AS role
               FROM team_members tm JOIN users u ON u.id = tm.user_id LEFT JOIN roles r ON r.id = u.role_id
              WHERE NOT tm.excluded AND u.status = 'active' ORDER BY u.name`),
      // FTE planned today on each project (for the person card)
      query(`SELECT a.user_id, a.project_id, sum(a.fte)::float AS fte FROM resource_allocations a
              WHERE a.start_date <= current_date AND (a.end_date IS NULL OR a.end_date >= current_date)
              GROUP BY a.user_id, a.project_id`),
    ]);
    const fte = new Map();
    for (const a of allocations.rows) {
      if (!fte.has(a.user_id)) fte.set(a.user_id, {});
      fte.get(a.user_id)[a.project_id] = a.fte;
    }
    const byTeam = new Map();
    for (const m of members.rows) {
      if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
      byTeam.get(m.team_id).push({ id: m.id, name: m.name, email: m.email, role: m.role, fte: fte.get(m.id) ?? {} });
    }
    res.json(projects.rows.map((p) => ({
      ...p,
      squads: squads.rows.filter((t) => t.project_id === p.id).map((t) => ({
        id: t.id, name: t.name, boardId: t.jira_board_id, kind: t.sprints > 0 ? 'scrum' : 'kanban', members: byTeam.get(t.id) ?? [],
      })),
    })));
  } catch (err) { next(err); }
});

export default router;
