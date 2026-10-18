import { createHash, randomBytes } from 'node:crypto';
import { query } from '../config/db.js';

// Server-side sessions. The browser holds a random token in an HttpOnly cookie;
// only the token's SHA-256 hash is stored in the database.
// A session ends after SESSION_IDLE_HOURS (default 6) without any request: each request pushes the end time forward.
export const COOKIE = 'am_session';
const IDLE_MS = Number(process.env.SESSION_IDLE_HOURS || 6) * 3600000;
const RENEW_AFTER_MS = 60000; // extend at most once a minute, not on every request
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + IDLE_MS);
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
  await query('DELETE FROM sessions WHERE expires_at < now()'); // tidy up old sessions
  return { token, expires };
}

export async function destroySession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// The signed-in user for a token, with their role's permissions; null if missing/expired/inactive
export async function userForToken(token) {
  const user = await sessionUser(token);
  if (!user) return null;
  const { session_expires: _expires, ...rest } = user;
  return rest;
}

// For a request: the signed-in user, and the session kept alive for another idle period
// (the cookie is renewed too). null if signed out or idle for too long.
export async function activeUser(req, res) {
  const token = readCookie(req);
  const user = await sessionUser(token);
  if (!user) return null;
  const { session_expires: expires, ...rest } = user;
  // Also shortens sessions made with a longer lifetime (before the idle limit, or after SESSION_IDLE_HOURS changed)
  if (Math.abs(Date.now() + IDLE_MS - expires.getTime()) > RENEW_AFTER_MS) {
    const renewed = new Date(Date.now() + IDLE_MS);
    await query('UPDATE sessions SET expires_at = $2 WHERE token_hash = $1', [sha256(token), renewed]);
    res.append('Set-Cookie', sessionCookie(token, renewed));
  }
  return rest;
}

async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.name, u.username, u.status, r.name AS role, COALESCE(r.permissions, '{}') AS permissions,
            s.expires_at AS session_expires
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  const user = rows[0];
  return user && user.status === 'active' ? user : null;
}

export function readCookie(req, name = COOKIE) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token, expires) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}${secure}`;
}

export const clearedCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
