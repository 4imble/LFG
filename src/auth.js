// Access control.
// - APP_PASSWORD is the admin password: every plan, plus creating plans and
//   setting their passwords.
// - Each plan can have its own password, which unlocks only that plan.
// A signed cookie remembers what this browser has unlocked. A plan grant
// carries a fingerprint of the plan's password, so changing a plan's password
// signs out everyone who used the old one.

import { createHmac, timingSafeEqual, createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const COOKIE = 'lfg_session';
const MAX_AGE_DAYS = 180;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(String(password), salt, 32);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(String(password ?? ''), salt, 32);
  const expected = Buffer.from(hash, 'base64url');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function makeAuth({ password, secret }) {
  // The secret defaults to one derived from the admin password, so changing it
  // signs everyone out.
  const key = secret || createHash('sha256').update(`lfg:${password}`).digest('hex');
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
  const fingerprint = (passwordHash) => sign(`fp:${passwordHash}`).slice(0, 12);

  const failures = new Map(); // ip -> { count, until }

  // Reads the session: { admin, grants: { planId: fingerprint } }.
  function read(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    const empty = { admin: false, grants: {} };
    if (!raw) return empty;
    const i = raw.lastIndexOf('.');
    if (i < 0) return empty;
    const payload = raw.slice(0, i);
    const sig = Buffer.from(raw.slice(i + 1));
    const expected = Buffer.from(sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return empty;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!(data.exp > Date.now())) return empty;
      return { admin: Boolean(data.admin), grants: data.grants && typeof data.grants === 'object' ? data.grants : {} };
    } catch {
      return empty;
    }
  }

  function write(req, res, session) {
    const data = { exp: Date.now() + MAX_AGE_DAYS * 864e5, admin: session.admin, grants: session.grants };
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`);
  }

  const canAccess = (session, plan) => session.admin
    || Boolean(plan?.password_hash && session.grants[plan.id] === fingerprint(plan.password_hash));

  function throttled(req) {
    const f = failures.get(req.ip || req.socket.remoteAddress || '?');
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  function recordFailure(req) {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const count = (failures.get(ip)?.count || 0) + 1;
    failures.set(ip, { count, until: count >= 5 ? Date.now() + Math.min(2 ** (count - 5), 60) * 60_000 : 0 });
  }

  function isAdminPassword(attempt) {
    const a = createHash('sha256').update(String(attempt ?? '')).digest();
    const b = createHash('sha256').update(password).digest();
    return timingSafeEqual(a, b);
  }

  // Tries a password against the admin password and every plan's password,
  // and adds whatever it unlocks to this browser's session.
  async function login(req, res, attempt, plans) {
    const wait = throttled(req);
    if (wait) return { ok: false, retryAfter: wait };
    const session = read(req);
    let unlocked = 0;
    if (isAdminPassword(attempt)) {
      session.admin = true;
      unlocked++;
    }
    for (const plan of plans) {
      if (plan.password_hash && await verifyPassword(attempt, plan.password_hash)) {
        session.grants[plan.id] = fingerprint(plan.password_hash);
        unlocked++;
      }
    }
    if (!unlocked) { recordFailure(req); return { ok: false }; }
    failures.delete(req.ip || req.socket.remoteAddress || '?');
    write(req, res, session);
    return { ok: true, session };
  }

  function logout(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  return { read, login, logout, canAccess };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}
