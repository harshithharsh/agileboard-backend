# AgileBoard – Backend

REST API for the AgileBoard sprint performance dashboard (Node.js, Express, PostgreSQL via `pg`).

## Setup
```bash
npm install
cp .env.example .env   # set DB credentials
npm run dev            # http://localhost:4000
```
Create the database first; see the `agileboard-database` repo.

## Endpoints
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | API + DB health check |
| GET | `/api/filters` | Options for the filter bar: projects, teams, releases, sprints, assignees |
| GET | `/api/dashboard?teamId=&sprintId=&assigneeId=&range=` | Everything the dashboard shows for one team and sprint. `sprintId` defaults to the latest sprint; `range` (1–6) sets how many sprints the trend charts include |

## How metrics are calculated
All metrics are calculated in `src/services/dashboard.js` from the raw sprint data.

| Metric | Formula |
|---|---|
| Predictability | completed committed points ÷ committed points |
| Completion | completed points ÷ (committed + added points) |
| Velocity | completed points |
| Spillover | spillover points ÷ (committed + added points) |
| Unplanned work | added points ÷ committed points |
| Defect escape rate | defects found in UAT or Prod ÷ all defects raised in the sprint |
| Velocity stable band | ±10% around the average of the previous sprints |
| Cycle time | completed_at − started_at for items completed in the sprint (avg, median, P85) |
| WIP | items in progress / review / test at sprint end (from status history) |
| Blocked work | issues blocked during the sprint; blocked time is the overlap with the sprint |
| Burndown | scope added so far − points completed, per working day |
| Sprint state | On track (all health metrics meet target), Attention (1 miss), At risk (2+ misses) |
