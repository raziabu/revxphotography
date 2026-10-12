import crypto from 'node:crypto';
import { getSetting } from './db.js';

const COOKIE = 'studio_admin';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const sign = (payload) =>
  crypto.createHmac('sha256', getSetting('session_secret')).update(payload).digest('base64url');

export function signIn(res) {
  const exp = String(Date.now() + THIRTY_DAYS);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS,
    secure: process.env.COOKIE_SECURE === '1',
  });
}

export function signOut(res) {
  res.clearCookie(COOKIE);
}

export function isAdmin(req) {
  const v = req.cookies?.[COOKIE];
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---- client (customer) sessions: cookie carries the client id, signed ----
const CLIENT_COOKIE = 'studio_client';

export function signInClient(res, clientId) {
  const payload = `${clientId}.${Date.now() + THIRTY_DAYS}`;
  res.cookie(CLIENT_COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', maxAge: THIRTY_DAYS, secure: process.env.COOKIE_SECURE === '1',
  });
}

export function signOutClient(res) {
  res.clearCookie(CLIENT_COOKIE);
}

/** Returns the signed-in client id, or null. */
export function clientIdFrom(req) {
  const v = req.cookies?.[CLIENT_COOKIE];
  if (!v) return null;
  const parts = v.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  const expected = sign(`${id}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

// ---- brute-force protection for password forms: 10 failed tries per 15 minutes per IP ----
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
export function loginLimiter(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first < WINDOW && rec.count >= 10) {
    return res.status(429).send('Too many attempts. Please wait 15 minutes and try again.');
  }
  res.on('finish', () => {
    if (res.statusCode === 401 || res.statusCode === 400) {
      const r = attempts.get(key);
      if (!r || now - r.first >= WINDOW) attempts.set(key, { first: now, count: 1 });
      else r.count += 1;
    } else if (res.statusCode === 302) attempts.delete(key);
  });
  if (attempts.size > 5000) attempts.clear();
  next();
}

export function requireAdmin(req, res, next) {
  if (!getSetting('admin_password_hash')) return res.redirect('/setup');
  if (isAdmin(req)) return next();
  if (req.method !== 'GET') return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
}
