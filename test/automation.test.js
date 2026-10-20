import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue, validateAutomation, nextRun } from '../src/services/automation.js';

const ist = { enabled: true, time: '22:00', timeZone: 'Asia/Kolkata' };
const at = (iso) => new Date(iso);

test('isDue: from the set time, for an hour, once per local day', () => {
  assert.equal(isDue(ist, {}, at('2026-10-20T16:29:00Z')), null); // 21:59 IST
  assert.equal(isDue(ist, {}, at('2026-10-20T16:30:00Z')), '2026-10-20'); // 22:00 IST
  assert.equal(isDue(ist, {}, at('2026-10-20T17:20:00Z')), '2026-10-20'); // 22:50 IST, catch-up
  assert.equal(isDue(ist, {}, at('2026-10-20T17:45:00Z')), null); // 23:15 IST, too late
  assert.equal(isDue(ist, { lastRunDate: '2026-10-20' }, at('2026-10-20T16:31:00Z')), null); // already ran
  assert.equal(isDue({ ...ist, enabled: false }, {}, at('2026-10-20T16:30:00Z')), null);
});

test('nextRun is the next 22:00 IST not yet run', () => {
  assert.equal(nextRun(ist, {}, at('2026-10-20T10:00:00Z')), '2026-10-20T16:30:00.000Z');
  assert.equal(nextRun(ist, { lastRunDate: '2026-10-20' }, at('2026-10-20T17:00:00Z')), '2026-10-21T16:30:00.000Z');
});

test('validateAutomation checks time, zone and emails', () => {
  const ok = { schedule: ist, notifications: { onSuccess: true, onFailure: true, recipients: ['harshith.as@polussolutions.com'] } };
  assert.equal(validateAutomation(ok), null);
  assert.match(validateAutomation({ ...ok, schedule: { ...ist, time: '25:00' } }), /Time/);
  assert.match(validateAutomation({ ...ok, schedule: { ...ist, timeZone: 'Mars/Base' } }), /time zone/);
  assert.match(validateAutomation({ ...ok, notifications: { ...ok.notifications, recipients: ['not-an-email'] } }), /valid email/);
});
