import { readCookie, userForToken } from './session.js';

// Attach req.user from the session cookie; 401 when not signed in.
export async function requireAuth(req, res, next) {
  try {
    const user = await userForToken(readCookie(req));
    if (!user) return res.status(401).json({ error: 'Please sign in' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// 403 unless the user's role has the permission ('admin' implies every permission)
export const requirePermission = (permission) => (req, res, next) => {
  const perms = req.user?.permissions || [];
  if (perms.includes(permission) || perms.includes('admin')) return next();
  res.status(403).json({ error: `Your role doesn't allow this (needs ${permission} permission)` });
};
