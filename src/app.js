import express from 'express';
import cors from 'cors';
import { query } from './config/db.js';
import users from './routes/users.js';
import projects from './routes/projects.js';
import issues from './routes/issues.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message || err.code || 'unreachable' });
  }
});

app.use('/api/users', users);
app.use('/api/projects', projects);
app.use('/api/issues', issues);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
