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

## Sign-in
Everything except `/api/health` needs a signed-in user. Create the first administrator yourself (asks for name, username and a hidden password):
```bash
npm run create-admin
```
After that, administrators give other people a username and password in **Admin → Users & Role Assignment**.

- Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly cookie (`am_session`), stored hashed in `sessions`. A session ends after 6 hours without activity (`SESSION_IDLE_HOURS`); every request keeps it alive.
- 5 failed sign-ins for a username from one IP lock it for 15 minutes.
- Roles: any signed-in user can view; **Refresh** (Jira sync) needs the `edit` permission; Admin needs `admin`.
- Set `COOKIE_SECURE=true` when serving over HTTPS, and `CORS_ORIGIN` if the frontend is not on `http://localhost:5173`.

## Jira sync
1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. In `.env`, set `JIRA_BASE_URL`, `JIRA_EMAIL` (your Atlassian login) and `JIRA_API_TOKEN`. Never commit `.env`.
3. Run `npm run sync`, or click **Refresh** on the dashboard (calls `POST /api/sync`).

Sprint start and end dates are converted from Jira's UTC timestamps to `JIRA_TIMEZONE` (default: the syncing Jira account's timezone), so they match the dates shown in Jira.

Each team maps to a Jira board (`teams.jira_board_id`), managed in **Admin → Project Configuration**; only active projects are synced.
For every board the sync pulls the active sprint(s), every closed sprint since `JIRA_SYNC_SINCE` (default 1 April, the start of the current Indian financial year) and at least the last `JIRA_SYNC_CLOSED_SPRINTS` (default 6) closed sprints,
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
| POST | `/api/auth/login`, `/api/auth/logout` | Sign in (username + password) / sign out |
| GET | `/api/auth/me` | The signed-in user and their permissions |
| GET / PUT | `/api/me/preferences` | The signed-in user's dashboard layout (`dashboardLayout`: `[{ id, size, hidden }]`, or `null` for the default) |
| GET | `/api/admin/jira/projects`, `/api/admin/jira/projects/:key/boards` | Active Jira projects (for Add Project) and a project's Scrum boards (filled in as teams) |
| GET / POST / PUT / DELETE | `/api/admin…` | Admin (needs `admin`): users (`/admin/users`), roles (`/admin/roles`), projects & teams (`/admin/projects`) |
| GET / POST | `/api/sync` | GET: latest sync status (`running`, `latest.status`, `latest.message`). POST (needs `edit`): start a Jira sync in the background and answer `202` at once; poll GET until `running` is false. A full sync takes 1–2 minutes, longer than hosting proxies keep a request open |
| GET | `/api/dashboard?teamId=&quarter=&sprintId=&assigneeId=` | Everything the dashboard shows for one team and sprint. `quarter` (Indian financial year, April–March: e.g. `FY2026-Q3` = Oct–Dec 2026) limits the trend charts to sprints that started in that quarter; `sprintId` defaults to the latest sprint (in the quarter) |

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
