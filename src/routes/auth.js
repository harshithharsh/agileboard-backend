import { Router } from 'express';
import { query } from '../config/db.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, readCookie, sessionCookie, clearedCookie, userForToken } from '../auth/session.js';

const router = Router();

// Slow down guessing: at most 5 failed attempts per username + IP in 15 minutes
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map(); // key -> [timestamps]
const recentFailures = (key) => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW_MS);

router.post('/auth/login', async (req, res, next) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password' });

  const key = `${username.toLowerCase()}|${req.ip}`;
  if (recentFailures(key).length >= MAX_FAILURES) {
    return res.status(429).json({ error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  }
  try {
    const { rows } = await query('SELECT id, password_hash, status FROM users WHERE lower(username) = lower($1)', [username]);
    const user = rows[0];
    const ok = user?.password_hash && (await verifyPassword(password, user.password_hash));
    if (!ok || user.status !== 'active') {
      failures.set(key, [...recentFailures(key), Date.now()]);
      // Same message for unknown user, wrong password and inactive account
      return res.status(401).json({ error: 'Incorrect username or password' });
    }
    failures.delete(key);
    const { token, expires } = await createSession(user.id);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    res.setHeader('Set-Cookie', sessionCookie(token, expires));
    res.json({ user: await userForToken(token) });
  } catch (err) { next(err); }
});

router.post('/auth/logout', async (req, res, next) => {
  try {
    await destroySession(readCookie(req));
    res.setHeader('Set-Cookie', clearedCookie());
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/auth/me', async (req, res, next) => {
  try {
    const user = await userForToken(readCookie(req));
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    res.json({ user });
  } catch (err) { next(err); }
});

export default router;
