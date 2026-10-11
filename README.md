# AgileBoard – Backend

REST API for the AgileBoard sprint performance dashboard (Node.js, Express, PostgreSQL via `pg`).
Sprint data comes from Jira Cloud: the backend syncs each team's Jira board into PostgreSQL.

## Setup
```bash
npm install
cp .env.example .env   # set DB credentials and Jira access
npm run sync           # pull sprints and issues from Jira
npm run dev            # http://localhost:4000
```
Create the database first; see the `agileboard-database` repo.

## Jira sync
1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. In `.env`, set `JIRA_BASE_URL`, `JIRA_EMAIL` (your Atlassian login) and `JIRA_API_TOKEN`. Never commit `.env`.
3. Run `npm run sync`, or click **Refresh** on the dashboard (calls `POST /api/sync`).

Sprint start and end dates are converted from Jira's UTC timestamps to `JIRA_TIMEZONE` (default: the syncing Jira account's timezone), so they match the dates shown in Jira.

Each team maps to a Jira board (`teams.jira_board_id`), managed in **Admin → Project Configuration**; only active projects are synced.

Jira credentials: the sync uses the most recently updated **active Jira API key from Admin** (stored AES-256-GCM encrypted with `APP_SECRET` from `.env`), and falls back to `JIRA_EMAIL` / `JIRA_API_TOKEN` in `.env`.
For every board the sync pulls the active sprint(s), every closed sprint since `JIRA_SYNC_SINCE` (default 1 January of the current year) and at least the last `JIRA_SYNC_CLOSED_SPRINTS` (default 6) closed sprints,
and for each sprint its issues with their changelog. Sub-tasks and epics are skipped.

| AgileBoard | From Jira |
|---|---|
| Committed vs added | When the issue joined the sprint (Sprint field in the changelog): after sprint start + 1h = added |
| Completed vs spillover | Status at the moment the sprint was closed. Done = a status in the board's **Done column** (as in Jira's sprint report) or in Jira's Done category |
| Story points | "Story point estimate" / "Story Points" field (auto-detected, or `JIRA_STORY_POINTS_FIELD`) |
| Status history, cycle time, WIP | Status changes in the changelog, mapped by status category and name (review / test) |
| Blocked work | Flagged as Impediment, or a status named Blocked / On hold |
| Defects | Bugs in the sprint; found in Prod / UAT when a label or Environment mentions it, otherwise QA |
| Release | The fix version most issues in the sprint use |
| Compliance | DoD = done; acceptance criteria = mentioned in the description; others are not tracked in Jira |

Tests for the Jira mapping: `npm test`.

## Endpoints
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | API + DB health check |
| GET | `/api/filters` | Options for the filter bar: projects, teams, releases, sprints, assignees |
| GET / POST / PUT / DELETE | `/api/admin…` | Admin: API keys (`/admin/api-keys`, `…/:id/test`), users (`/admin/users`), roles (`/admin/roles`), projects & teams (`/admin/projects`). Not access-controlled yet (no login) |
| GET / POST | `/api/sync` | Last sync status / run a Jira sync now |
| GET | `/api/dashboard?teamId=&quarter=&sprintId=&assigneeId=` | Everything the dashboard shows for one team and sprint. `quarter` (e.g. `2026-Q3`) limits the trend charts to sprints that started in that quarter; `sprintId` defaults to the latest sprint (in the quarter) |

## How metrics are calculated
All metrics are calculated in `src/services/dashboard.js` from the raw sprint data.

| Metric | Formula |
|---|---|
| Predictability | completed committed points ÷ committed points |
| Completion | achieved velocity ÷ committed velocity: completed points from the sprint's commitment ÷ committed points |
| Velocity | completed points |
| Spillover | spillover points ÷ (committed + added points) |
| Business value delivered | stories completed ÷ total stories in the sprint × 100 (all Story issues in the sprint, planned or added; completed = done when it closed) |
| Unplanned work | added points ÷ committed points |
| Defect rate | number of stories in the sprint ÷ bugs created in the sprint (created between sprint start and close); empty when none were created |
| Defect density | achieved velocity ÷ bugs created in the sprint; empty when none were created |
| Velocity stable band | ±10% around the average of the previous sprints |
| Cycle time | completed_at − started_at for items completed in the sprint (avg, median, P85) |
| WIP | items in progress / review / test at sprint end (from status history) |
| Blocked work | issues blocked during the sprint (blocks shorter than 1 hour are ignored); blocked time is the overlap with the sprint |
| Burndown | scope added so far − points completed, per working day |
| Time elapsed | working days passed ÷ working days in the sprint (100% once closed) |
| P1 - Blocker | issues with Jira priority "P1 - Blocker" still open at sprint end (or now, while active); target 0 |
| Sprint state | On track (all health metrics meet target), Attention (1 miss), At risk (2+ misses) |

A closed sprint is measured up to the moment it was closed in Jira, which can be after its planned end date.
