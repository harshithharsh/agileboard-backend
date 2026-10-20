import { query } from '../config/db.js';
import { syncFromJira } from '../jira/sync.js';
import { sendEmail, emailStatus } from './mailer.js';

// Nightly Jira sync and its email notifications, configured by an admin in Workspace Settings.
// Stored in app_settings: 'sync_schedule', 'notifications' (settings) and 'sync_schedule_state' (last run).
export const SCHEDULE_DEFAULTS = { enabled: false, time: '22:00', timeZone: process.env.JIRA_TIMEZONE || 'Asia/Kolkata' };
export const NOTIFY_DEFAULTS = { onSuccess: true, onFailure: true, recipients: [] };
const CATCH_UP_MINUTES = 60; // if the server was down at the scheduled time, still run within the next hour

async function getSetting(key, defaults) {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return { ...defaults, ...(rows[0]?.value ?? {}) };
}

async function putSetting(key, value, userId = null) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId]
  );
}

export const getSchedule = () => getSetting('sync_schedule', SCHEDULE_DEFAULTS);
export const getNotifications = () => getSetting('notifications', NOTIFY_DEFAULTS);
export const getScheduleState = () => getSetting('sync_schedule_state', {});

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export function validateAutomation({ schedule, notifications }) {
  if (typeof schedule?.enabled !== 'boolean') return 'schedule.enabled must be true or false';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time ?? '')) return 'Time must look like 22:00';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timeZone }); } catch { return 'Unknown time zone'; }
  if (typeof notifications?.onSuccess !== 'boolean' || typeof notifications?.onFailure !== 'boolean') return 'Notification choices must be true or false';
  if (!Array.isArray(notifications.recipients) || notifications.recipients.length > 20) return 'Recipients must be a list of up to 20 email addresses';
  const bad = notifications.recipients.find((r) => !EMAIL.test(r));
  if (bad) return `Not a valid email address: ${bad}`;
  return null;
}

export async function saveAutomation({ schedule, notifications }, userId) {
  await putSetting('sync_schedule', { enabled: schedule.enabled, time: schedule.time, timeZone: schedule.timeZone }, userId);
  await putSetting('notifications', {
    onSuccess: notifications.onSuccess,
    onFailure: notifications.onFailure,
    recipients: [...new Set(notifications.recipients.map((r) => r.trim().toLowerCase()))],
  }, userId);
}

// Wall-clock date and time in a time zone: { date: '2026-10-20', minutes: 1320 }
function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// Is a scheduled run due now? Due from the set time, for up to an hour, once per local day.
export function isDue(schedule, state, now = new Date()) {
  if (!schedule.enabled) return null;
  const { date, minutes } = localNow(schedule.timeZone, now);
  const late = minutes - minutesOf(schedule.time);
  if (late < 0 || late > CATCH_UP_MINUTES || state.lastRunDate === date) return null;
  return date;
}

// Claim today's run in the database, so a restart (or a second server) can't run it twice
async function claimRun(date) {
  const { rowCount } = await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('sync_schedule_state', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = app_settings.value || EXCLUDED.value, updated_at = now()
       WHERE app_settings.value->>'lastRunDate' IS DISTINCT FROM $2`,
    [JSON.stringify({ lastRunDate: date, lastStartedAt: new Date().toISOString() }), date]
  );
  return rowCount > 0;
}

const appLink = () => (process.env.APP_URL ? `\n\nOpen AgileMetrix: ${process.env.APP_URL}` : '');

export async function notify(result) {
  const settings = await getNotifications();
  const wanted = result.status === 'success' ? settings.onSuccess : settings.onFailure;
  if (!wanted || !settings.recipients.length || !emailStatus().configured) return false;
  const when = new Date(result.finishedAt).toUTCString();
  const subject = result.status === 'success'
    ? `AgileMetrix: nightly Jira sync completed`
    : `AgileMetrix: nightly Jira sync failed`;
  const text = result.status === 'success'
    ? `The scheduled Jira sync finished successfully.\n\n${result.message}\nDuration: ${result.seconds} seconds\nFinished: ${when}${appLink()}`
    : `The scheduled Jira sync failed.\n\nReason: ${result.message}\nFinished: ${when}\n\nThe dashboard keeps showing the last synced data.${appLink()}`;
  await sendEmail({ to: settings.recipients, subject, text });
  return true;
}

export async function runScheduledSync(date) {
  const started = Date.now();
  let result;
  try {
    const r = await syncFromJira({ log: () => {} });
    result = { status: 'success', message: r.message };
  } catch (err) {
    result = { status: 'failed', message: err.message };
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  result.finishedAt = new Date().toISOString();
  let emailed = false;
  try {
    emailed = await notify(result);
  } catch (err) {
    console.error('Could not send the sync email:', err.message);
    result.emailError = err.message;
  }
  await query(
    `UPDATE app_settings SET value = value || $1, updated_at = now() WHERE key = 'sync_schedule_state'`,
    [JSON.stringify({ lastRunDate: date, lastStatus: result.status, lastMessage: result.message, lastFinishedAt: result.finishedAt, lastEmailed: emailed, lastEmailError: result.emailError ?? null })]
  );
  console.log(`Scheduled Jira sync ${result.status}: ${result.message}${emailed ? ' (email sent)' : ''}`);
}

// Check every 30 seconds whether the nightly sync is due
export function startScheduler() {
  const tick = async () => {
    try {
      const date = isDue(await getSchedule(), await getScheduleState());
      if (date && (await claimRun(date))) await runScheduledSync(date);
    } catch (err) {
      console.error('Scheduler check failed:', err.message);
    }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 30000);
}

// Next scheduled run as an ISO time, for the admin screen
export function nextRun(schedule, state, now = new Date()) {
  if (!schedule.enabled) return null;
  for (let day = 0; day <= 2; day += 1) {
    // try each minute-of-day candidate: today and the next two days, in the schedule's time zone
    const probe = new Date(now.getTime() + day * 86400000);
    const { date } = localNow(schedule.timeZone, probe);
    if (date === state.lastRunDate) continue;
    // find the UTC instant whose local time is date + schedule.time (scan ±14h around the guess)
    const guess = new Date(`${date}T${schedule.time}:00Z`).getTime();
    for (let off = -14 * 60; off <= 14 * 60; off += 15) {
      const t = new Date(guess + off * 60000);
      const l = localNow(schedule.timeZone, t);
      if (l.date === date && l.minutes === minutesOf(schedule.time) && t > now) return t.toISOString();
    }
  }
  return null;
}
