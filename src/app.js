import express from 'express';
import cors from 'cors';
import { query } from './config/db.js';
import dashboard from './routes/dashboard.js';
import sync from './routes/sync.js';
import admin from './routes/admin.js';
import auth from './routes/auth.js';
import preferences from './routes/preferences.js';
import sprints from './routes/sprints.js';
import settings from './routes/settings.js';
import integrations from './routes/integrations.js';
import redmine from './routes/redmine.js';
import resources from './routes/resources.js';
import teamMap from './routes/teamMap.js';
import reports from './routes/reports.js';
import { requireAuth, requirePermission } from './auth/middleware.js';

const app = express();
// Cookies (sign-in) need an explicit origin; in development the Vite proxy makes requests same-origin
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message || err.code || 'unreachable' });
  }
});

// Sign-in routes are public; everything below requires a signed-in, active user
app.use('/api', auth);
app.use('/api', requireAuth);
app.use('/api/admin', requirePermission('admin'));

app.use('/api', dashboard);
app.use('/api', sync);
app.use('/api', admin);
app.use('/api', preferences);
app.use('/api', sprints);
app.use('/api', settings);
app.use('/api', integrations);
app.use('/api', redmine);
app.use('/api', resources);
app.use('/api', teamMap);
app.use('/api', reports);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
