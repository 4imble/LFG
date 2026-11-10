// One shared password for everyone. A signed cookie remembers the browser.

import { createHmac, timingSafeEqual, createHash, randomBytes } from 'node:crypto';

const COOKIE = 'lfg_session';
const MAX_AGE_DAYS = 180;

export function makeAuth({ password, secret }) {
  // The secret defaults to one derived from the password, so changing the
  // password signs everyone out.
  const key = secret || createHash('sha256').update(`lfg:${password}`).digest('hex');
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  const failures = new Map(); // ip -> { count, until }

  function issue(req, res) {
    const exp = Date.now() + MAX_AGE_DAYS * 864e5;
    const payload = `${exp}.${randomBytes(6).toString('base64url')}`;
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`);
  }

  function valid(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const i = raw.lastIndexOf('.');
    const payload = raw.slice(0, i);
    const sig = Buffer.from(raw.slice(i + 1));
    const expected = Buffer.from(sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
    return Number(payload.split('.')[0]) > Date.now();
  }

  function checkPassword(req, attempt) {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return { ok: false, retryAfter: Math.ceil((f.until - Date.now()) / 1000) };
    const a = createHash('sha256').update(String(attempt ?? '')).digest();
    const b = createHash('sha256').update(password).digest();
    if (timingSafeEqual(a, b)) { failures.delete(ip); return { ok: true }; }
    const count = (f?.count || 0) + 1;
    failures.set(ip, { count, until: count >= 5 ? Date.now() + Math.min(2 ** (count - 5), 60) * 60_000 : 0 });
    return { ok: false };
  }

  function logout(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  return { issue, valid, checkPassword, logout };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
