// Shared state and plumbing for the front end: API calls, routing, toasts,
// modals and pop-up menus. Views and editors import from here; app.js wires
// the renderers in through `hooks` so nothing here depends on them.

import { esc } from './lib/format.js';

export const $app = document.getElementById('app');
export const $modal = document.getElementById('modal-root');

export const KINDS = {
  flight: '✈️', transport: '🚆', stay: '🏨', place: '📍', activity: '🎟️', food: '🍜', event: '🎉',
  idea: '💡', note: '📝', todo: '✅', cost: '💷', document: '📄', contact: '👤', other: '✨',
};
export const STATUSES = ['idea', 'considering', 'shortlisted', 'booked', 'done', 'rejected'];
export const LAYOUTS = { cards: 'Cards', table: 'Table', timeline: 'Timeline', list: 'Checklist', notes: 'Notes' };

export const state = {
  ai: false,
  admin: false,
  signedIn: false,
  plans: [],
  plan: null,        // { id, version, doc, hasPassword, archived }
  chat: [],
  chatOpen: false,
  thinking: false,
  steps: [],         // live progress lines while the assistant works
  draft: '',
  filter: 'all',
  query: '',
  history: null,
  aiSettings: null,
  newSince: null,    // { from, to } when the plan changed since this browser last saw it
};

// Set by app.js: { render, rerender, login }.
export const hooks = {};
export const rerender = () => hooks.rerender();

// ---------- local storage ----------
export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
// The name was stored as a bare string before, so read it without JSON.
export const name = () => { try { return localStorage.getItem('lfg_name') || ''; } catch { return ''; } };
export const setName = (n) => { try { localStorage.setItem('lfg_name', n); } catch { /* ignore */ } };

// ---------- icons ----------
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.500a6.5 6.5 0 0 0 10 10z"/>',
  sparkles: '<path d="M11 4l1.8 4.700L17.5 10.500l-4.7 1.800L11 17l-1.8-4.700L4.5 10.500l4.7-1.800zM18.5 3v4M16.5 5h4M19 16v3M17.5 17.500h3"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.200L3.5 8.500M3.5 3.500v5h5M12 7.500V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  pin: '<path d="M12 21s7-6.1 7-11.200a7 7 0 1 0-14 0C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.500s5.9 1.9 6.5 5.500M16 4.800a3.5 3.5 0 0 1 0 6.400M18.5 14.800c1.7.8 2.7 2.6 3 5.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.500V12l3 2"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  download: '<path d="M12 3.500v11M7.5 10.500l4.5 4.5 4.5-4.500M5 20.500h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.500l4 4"/>',
  print: '<path d="M7 8V3.500h10V8M7 17H4.500a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1H17M7 14h10v6.500H7z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3A4.5 4.5 0 0 0 13 4.600l-1.2 1.200M14 10a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 19.400l1.2-1.2"/>',
  check: '<path d="m5 12.5 4.5 4.500L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.500V8a4 4 0 0 1 8 0v2.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.500c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
export const icon = (n, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ---------- toast ----------
// toast('Deleted', { undo: async () => … }) adds an Undo button.
export function toast(msg, { undo = null } = {}) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  if (undo) {
    t.querySelector('button').onclick = async () => {
      t.classList.remove('show');
      try { await undo(); } catch (err) { toast(`⚠️ ${err.message}`); }
    };
  }
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), undo ? 7000 : 2800);
}

// ---------- api ----------
const headers = () => ({ 'content-type': 'application/json', 'x-lfg-name': encodeURIComponent(name()) });
const SIGNED_OUT = 'Not signed in';
export const isSignedOut = (err) => err?.message === SIGNED_OUT;

async function check(res, path) {
  if (res.status === 401 && path !== '/login') { hooks.login(); throw new Error(SIGNED_OUT); }
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.locked) { state.plan = null; hooks.login({ locked: true }); throw new Error(SIGNED_OUT); }
  throw new Error(data.error || `Request failed (${res.status})`);
}

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: headers(),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch { throw new Error('Can\'t reach the server. Check your connection and try again.'); }
  await check(res, path);
  return res.json().catch(() => ({}));
}

// POSTs and reads a newline-delimited JSON reply, calling onEvent for each
// line. Resolves with the final "done" event.
export async function apiStream(path, body, onEvent) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  await check(res, path);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') done = event; else onEvent(event);
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer);
  if (!done) throw new Error('The connection dropped before the assistant finished. Reload to see what it saved.');
  return done;
}

// ---------- plan state ----------
export function findItem(id) {
  for (const tab of state.plan?.doc.tabs || []) {
    const item = tab.items.find((x) => x.id === id);
    if (item) return { tab, item };
  }
  return null;
}

// Records the newest version of the plan this browser has shown.
export function markSeen() {
  if (state.plan) lsSet(`lfg_seen_${state.plan.id}`, state.plan.version);
}

export function setPlanDoc({ doc, version }) {
  state.plan.doc = doc;
  state.plan.version = version;
  markSeen();
}

export async function saveOps(ops, summary) {
  try {
    const res = await api(`/plans/${state.plan.id}/ops`, { body: { ops, summary } });
    setPlanDoc(res);
    return res;
  } catch (err) {
    if (!isSignedOut(err)) toast(`⚠️ ${err.message}`);
    throw err;
  }
}

// Offers to undo the change saved as `version` by restoring the one before it.
// The server refuses if anyone has edited the plan since.
export function undoToast(message, version) {
  const planId = state.plan.id;
  toast(message, {
    undo: async () => {
      const res = await api(`/plans/${planId}/versions/${version - 1}/restore`, { body: { ifVersion: version } });
      if (state.plan?.id === planId) { setPlanDoc(res); rerender(); }
      toast('Undone');
    },
  });
}

// ---------- routing ----------
export function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    const history = parts[2] === 'history';
    return { view: 'plan', planId: parts[1], tab: parts[2] === 't' ? parts[3] : history ? 'history' : 'overview', version: history ? Number(parts[3]) || null : null };
  }
  if (parts[0] === 'admin') return { view: 'admin' };
  return { view: 'home' };
}
export const go = (hash) => { if (location.hash !== hash) location.hash = hash; else hooks.render(); };

// ---------- modal ----------
let modal = null; // { dirty, warned, returnFocus }

// Opens a dialog. With { guard: true } an edited form isn't thrown away by a
// stray click outside or a press of Escape: the first attempt only warns.
export function openModal(html, onMount, { guard = false } = {}) {
  const returnFocus = modal?.returnFocus || document.activeElement;
  $modal.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div></div>`;
  modal = { dirty: false, warned: false, guard, returnFocus };
  const back = $modal.firstElementChild;
  const box = back.firstElementChild;
  back.addEventListener('mousedown', (e) => { if (e.target === back) requestClose(); });
  box.addEventListener('input', () => { if (modal) modal.dirty = true; });
  box.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (!closer) return;
    if (closer.dataset.close === 'force') closeModal(); else requestClose();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...box.querySelectorAll('a[href], button, input, select, textarea, summary')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.body.classList.add('no-scroll');
  onMount?.(box);
  (box.querySelector('[autofocus]') || box.querySelector('form input:not([type=hidden]), form textarea') || box).focus();
  return box;
}
export function closeModal() {
  if (!modal) return;
  const { returnFocus } = modal;
  modal = null;
  $modal.innerHTML = '';
  if (!state.chatOpen) document.body.classList.remove('no-scroll');
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
export function requestClose() {
  if (modal?.guard && modal.dirty && !modal.warned) {
    modal.warned = true;
    toast('You have unsaved changes. Close again to discard them.');
    return;
  }
  closeModal();
}
export const modalOpen = () => Boolean(modal);

// ---------- pop-up menu ----------
let menu = null;
export function closeMenu() {
  menu?.remove();
  menu = null;
}
// items: [{ label, icon, emoji, onClick, danger, current } | 'divider']
export function openMenu(anchor, items) {
  closeMenu();
  menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, n) => (it === 'divider' ? '<hr>' : `
    <button type="button" role="menuitem" data-n="${n}" class="${it.danger ? 'danger' : ''} ${it.current ? 'current' : ''}">
      ${it.html || `${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>`}${it.current ? icon('check', 'tick') : ''}
    </button>`)).join('');
  menu.openedAt = performance.now();
  menu.openedY = window.scrollY;
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = menu;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const below = r.bottom + 6;
  const top = below + h + 8 > window.innerHeight && r.top - h - 6 > 0 ? r.top - h - 6 : Math.max(8, Math.min(below, window.innerHeight - h - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    const it = items[Number(b.dataset.n)];
    closeMenu();
    it.onClick?.();
  });
  menu.querySelector('button')?.focus({ preventScroll: true });
}
export const menuOpen = () => Boolean(menu);
document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
// Scrolling away closes the menu, but not the tail end of a scroll that was
// already under way when it opened.
window.addEventListener('scroll', () => {
  if (menu && performance.now() - menu.openedAt > 300 && Math.abs(window.scrollY - menu.openedY) > 4) closeMenu();
}, { passive: true });
window.addEventListener('resize', closeMenu);

// ---------- misc ----------
export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const slug = (s) => String(s || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
