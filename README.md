# AgileBoard – Backend

REST API for AgileBoard built with Node.js, Express and PostgreSQL (`pg`).

## Setup
```bash
npm install
cp .env.example .env   # set DB credentials
npm run dev            # http://localhost:4000
```
The database must be created first. See the `agileboard-database` repo.

## Endpoints
| Method | Path | Description |
|---|---|---|
| GET | /api/health | API + DB health check |
| GET | /api/users | List users |
| GET/POST | /api/projects | List / create projects (creates default columns) |
| GET | /api/projects/:id/board | Active sprint board (columns + issues) |
| GET | /api/projects/:id/backlog | Issues not in a sprint |
| GET | /api/projects/:id/sprints | Sprints for a project |
| GET/PATCH/DELETE | /api/issues/:id | Read / update / delete an issue |
| POST | /api/issues | Create an issue |
