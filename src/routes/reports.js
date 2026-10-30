import { Router } from 'express';
import { query } from '../config/db.js';
import { requirePermission } from '../auth/middleware.js';
import { emailStatus, sendEmail } from '../services/mailer.js';

// Weekly Redmine update email (Effort Tracker): the screen works out who to mention and writes the
// email; the server only sends it to the signed-in person, who then forwards it to the team.
const router = Router();

const myEmail = async (userId) => (await query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]?.email ?? null;

router.get('/reports/redmine-weekly/recipient', requirePermission('edit'), async (req, res, next) => {
  try {
    res.json({ email: await myEmail(req.user.id), emailConfigured: emailStatus().configured });
  } catch (err) { next(err); }
});

router.post('/reports/redmine-weekly/email', requirePermission('edit'), async (req, res, next) => {
  try {
    const { subject, html, text } = req.body ?? {};
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) return res.status(400).json({ error: 'Subject is missing' });
    if (typeof html !== 'string' || typeof text !== 'string' || html.length > 100000 || text.length > 50000) return res.status(400).json({ error: 'Email body is missing or too long' });
    if (!emailStatus().configured) return res.status(400).json({ error: 'Email is not set up on the server (Settings → Integrations → Email). Use Copy email instead.' });
    const to = await myEmail(req.user.id);
    if (!to) return res.status(400).json({ error: 'Your account has no email address. Add it in Settings → Users, or use Copy email.' });
    await sendEmail({ to, subject: subject.trim(), html, text });
    res.json({ sentTo: to });
  } catch (err) { next(err); }
});

export default router;
