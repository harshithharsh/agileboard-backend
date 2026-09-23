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

Each team maps to a Jira board (`teams.jira_board_id`): Nexo → 524, Vertex → 12, Nexus → 826.
For every board the sync pulls the active sprint(s) plus the last `JIRA_SYNC_CLOSED_SPRINTS` (default 6) closed sprints,
and for each sprint its issues with their changelog. Sub-tasks and epics are skipped.

| AgileBoard | From Jira |
|---|---|
| Committed vs added | When the issue joined the sprint (Sprint field in the changelog): after sprint start + 1h = added |
| Completed vs spillover | Status at the moment the sprint was closed (done category = completed) |
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
| GET / POST | `/api/sync` | Last sync status / run a Jira sync now |
| GET | `/api/dashboard?teamId=&sprintId=&assigneeId=&range=` | Everything the dashboard shows for one team and sprint. `sprintId` defaults to the latest sprint; `range` (1–6) sets how many sprints the trend charts include |
| GET | `/api/dashboard?projectId=&sprintId=YYYY-MM-DD&…` | All of a project's teams combined. Sprints that start on the same day are combined into one period (e.g. "Nexo 12 / Vertex 13"); `sprintId` is that start date |

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
| Blocked work | issues blocked during the sprint; blocked time is the overlap with the sprint |
| Burndown | scope added so far − points completed, per working day |
| Sprint state | On track (all health metrics meet target), Attention (1 miss), At risk (2+ misses) |

A closed sprint is measured up to the moment it was closed in Jira, which can be after its planned end date.
