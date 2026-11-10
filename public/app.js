// LFG front end: plain JS, no build step.

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');

const KINDS = {
  flight: '✈️', transport: '🚆', stay: '🏨', place: '📍', activity: '🎟️', food: '🍜', event: '🎉',
  idea: '💡', note: '📝', todo: '✅', cost: '💷', document: '📄', contact: '👤', other: '✨',
};
const STATUSES = ['idea', 'considering', 'shortlisted', 'booked', 'done', 'rejected'];
const LAYOUTS = { cards: 'Cards', table: 'Table', timeline: 'Timeline', list: 'Checklist', notes: 'Notes' };

const state = {
  ai: false,
  plans: [],
  plan: null,        // { id, version, doc }
  chat: [],
  chatOpen: false,
  thinking: false,
  filter: 'all',
  history: null,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');
const name = () => { try { return localStorage.getItem('lfg_name') || ''; } catch { return ''; } };
const setName = (n) => { try { localStorage.setItem('lfg_name', n); } catch { /* ignore */ } };

function md(text) {
  if (!text) return '';
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*•]\s+(.*)/);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

function money(p) {
  if (!p || p.amount == null) return '';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency || 'GBP', maximumFractionDigits: p.amount % 1 ? 2 : 0 }).format(p.amount);
  } catch { return `${p.amount} ${p.currency || ''}`; }
}

function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
function fmtDate(s, { short = false } = {}) {
  if (!s) return '';
  const d = parseDate(s);
  if (s.length === 7) return d.toLocaleDateString('en-GB', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}
function dateRange(a, b) {
  if (!a && !b) return '';
  if (a && b) return `${fmtDate(a, { short: true })} → ${fmtDate(b, { short: !b.startsWith(a.slice(0, 4)) ? false : true })}`;
  return fmtDate(a || b);
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-lfg-name': encodeURIComponent(name()) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { renderLogin(); throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.locked) { state.plan = null; renderLogin({ locked: true }); throw new Error('Not signed in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const allItems = (doc) => doc.tabs.flatMap((t) => t.items.map((i) => ({ ...i, tabId: t.id, tabTitle: t.title })));
function findItem(id) {
  for (const t of state.plan.doc.tabs) {
    const i = t.items.find((x) => x.id === id);
    if (i) return { tab: t, item: i };
  }
  return null;
}

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    return { view: 'plan', planId: parts[1], tab: parts[2] === 't' ? parts[3] : parts[2] === 'history' ? 'history' : 'overview', version: parts[2] === 'history' ? Number(parts[3]) || null : null };
  }
  if (parts[0] === 'admin') return { view: 'admin' };
  return { view: 'home' };
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };
window.addEventListener('hashchange', () => { state.filter = 'all'; render(); });

async function render() {
  const r = route();
  try {
    if (r.view === 'admin') {
      if (!state.admin) return go('#/');
      state.plans = await api('/plans');
      return renderAdmin();
    }
    if (r.view === 'home') {
      state.plans = await api('/plans');
      return renderHome();
    }
    if (!state.plan || state.plan.id !== r.planId) {
      state.plan = await api(`/plans/${r.planId}`);
      state.chat = state.ai ? await api(`/plans/${r.planId}/chat`) : [];
    }
    if (r.tab === 'history') {
      state.history = await api(`/plans/${r.planId}/versions`);
      if (r.version) state.history.selected = await api(`/plans/${r.planId}/versions/${r.version}`);
    }
    renderPlan(r);
  } catch (err) {
    if (err.message !== 'Not signed in') {
      $app.innerHTML = `<div class="page"><div class="empty"><div class="big">🧭</div><p>${esc(err.message)}</p><a class="btn" href="#/">Back to plans</a></div></div>`;
    }
  }
}

// ---------- login ----------
function renderLogin({ locked = false } = {}) {
  $modal.innerHTML = '';
  const signedIn = state.signedIn;
  $app.innerHTML = `
    <div class="login">
      <form class="login-card" id="login">
        <div><div class="display" style="font-size:44px">🧭</div><h1>LFG</h1><div class="muted">${locked ? 'This plan has its own password. Enter it to open the plan.' : 'Let\'s flipping go. Enter the password you were given.'}</div></div>
        <label class="field">Your name <input type="text" name="name" value="${esc(name())}" placeholder="So we know who added what" autocomplete="nickname"></label>
        <label class="field">Password <input type="password" name="password" required autofocus autocomplete="current-password"></label>
        <div class="error" id="login-error"></div>
        <button class="btn primary" style="justify-content:center">${locked ? 'Unlock' : 'Let\'s go'}</button>
        ${signedIn ? '<a class="btn ghost" href="#/" style="justify-content:center">Back to my plans</a>' : ''}
      </form>
    </div>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    setName(String(f.get('name') || '').trim());
    try {
      await api('/login', { body: { password: f.get('password') } });
      await boot(true);
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
    }
  });
}

// ---------- top bar ----------
function topbar(extra = '') {
  return `<header class="topbar">
    <a class="brand" href="#/">LFG<span>.</span></a>
    ${extra}
    <div class="spacer"></div>
    ${state.admin ? '<a class="btn ghost sm" href="#/admin">⚙️ Admin</a>' : ''}
    <button class="who btn ghost sm" data-action="rename-me" title="Change your name">👤 ${esc(name() || 'Set your name')}</button>
    <button class="icon-btn" data-action="theme" title="Toggle light/dark">◐</button>
    <button class="icon-btn" data-action="logout" title="Sign out">⎋</button>
  </header>`;
}

// ---------- home ----------
function renderHome() {
  const active = state.plans.filter((p) => !p.archived);
  const archived = state.plans.filter((p) => p.archived);
  const card = (p) => `
    <a class="plan-card" href="#/p/${p.id}">
      <div class="emoji">${esc(p.emoji || '🧭')}</div>
      <h2>${esc(p.title)}</h2>
      ${p.subtitle ? `<div class="muted">${esc(p.subtitle)}</div>` : ''}
      <div class="small muted">${[dateRange(p.start, p.end), `${p.itemCount} item${p.itemCount === 1 ? '' : 's'}`, `updated ${ago(p.updated_at)}`].filter(Boolean).join(' · ')}</div>
    </a>`;
  $app.innerHTML = `${topbar()}
    <main class="page">
      <section class="hero"><h1>Where next?</h1><p class="muted">Every trip gets its own plan. Dump ideas in, and the assistant keeps them tidy.</p></section>
      <div class="plan-grid">
        ${active.map(card).join('')}
        ${state.admin ? '<button class="plan-card new" data-action="new-plan"><div class="emoji">＋</div><div>New plan</div></button>' : '<button class="plan-card new" data-action="unlock"><div class="emoji">🔑</div><div>Got another plan\'s password?</div></button>'}
      </div>
      ${archived.length ? `<h2 class="section-title">Archived</h2><div class="plan-grid">${archived.map(card).join('')}</div>` : ''}
    </main>`;
}

// ---------- admin ----------
function renderAdmin() {
  document.title = 'Admin · LFG';
  const row = (p) => `
    <div class="admin-row ${p.archived ? 'archived' : ''}">
      <a class="admin-plan" href="#/p/${p.id}"><span class="emoji">${esc(p.emoji || '🧭')}</span>
        <span><strong>${esc(p.title)}</strong><div class="small muted">${[dateRange(p.start, p.end), `${p.itemCount} items`, `updated ${ago(p.updated_at)}`, p.archived ? 'archived' : ''].filter(Boolean).join(' · ')}</div></span></a>
      <div class="admin-pw">
        <span class="small ${p.hasPassword ? '' : 'muted'}">${p.hasPassword ? '🔒 Has a password' : '🔓 No password: only you can open it'}</span>
        <div style="display:flex;gap:6px">
          <input type="text" data-pw-input="${p.id}" placeholder="${p.hasPassword ? 'New password' : 'Set a password'}" autocomplete="off">
          <button class="btn sm" data-action="set-password" data-plan="${p.id}">${p.hasPassword ? 'Reset' : 'Set'}</button>
          ${p.hasPassword ? `<button class="btn sm danger" data-action="clear-password" data-plan="${p.id}" title="Remove password">✕</button>` : ''}
        </div>
      </div>
      <div class="admin-actions">
        <button class="btn sm" data-action="copy-link" data-plan="${p.id}">🔗 Copy link</button>
        <button class="btn sm ghost" data-action="archive" data-plan="${p.id}" data-archived="${p.archived ? 1 : 0}">${p.archived ? 'Unarchive' : 'Archive'}</button>
      </div>
    </div>`;
  $app.innerHTML = `${topbar()}
    <main class="page">
      <section class="hero" style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px"><h1>Admin</h1>
        <p class="muted">Every plan, its password and its link. To share a plan, copy its link and send its password separately. Whoever has both can see and edit that plan, and nothing else.</p></div>
        <button class="btn primary" data-action="new-plan">＋ New plan</button>
      </section>
      <div class="admin-list">${state.plans.length ? state.plans.map(row).join('') : '<div class="empty">No plans yet. Create the first one.</div>'}</div>
    </main>`;
}

// ---------- plan ----------
function renderPlan(r) {
  const { doc } = state.plan;
  document.title = `${doc.title} · LFG`;
  const days = doc.start ? Math.ceil((parseDate(doc.start) - Date.now()) / 864e5) : null;
  const countdown = days == null ? '' : days > 0 ? `<span class="countdown">${days} day${days === 1 ? '' : 's'} to go</span>` : (doc.end && parseDate(doc.end) >= Date.now() - 864e5 ? '<span class="countdown">Happening now</span>' : '');
  const tabs = [
    `<a class="tab ${r.tab === 'overview' ? 'active' : ''}" href="#/p/${state.plan.id}">🗺️ Overview</a>`,
    ...doc.tabs.map((t) => `<a class="tab ${r.tab === t.id ? 'active' : ''}" href="#/p/${state.plan.id}/t/${t.id}">${esc(t.emoji)} ${esc(t.title)} <span class="count">${t.items.length}</span></a>`),
    `<button class="tab add" data-action="add-tab" title="Add a tab">＋</button>`,
    `<a class="tab right ${r.tab === 'history' ? 'active' : ''}" href="#/p/${state.plan.id}/history">🕘 History</a>`,
  ].join('');

  let body;
  if (r.tab === 'overview') body = overview(doc);
  else if (r.tab === 'history') body = historyView(r);
  else {
    const tab = doc.tabs.find((t) => t.id === r.tab);
    body = tab ? tabView(tab) : `<div class="empty" style="margin-top:20px">That tab no longer exists. <a href="#/p/${state.plan.id}">Go to overview</a></div>`;
  }

  $app.innerHTML = `${topbar()}
    <main class="page">
      <div class="plan-head">
        <div class="emoji">${esc(doc.emoji || '🧭')}</div>
        <div style="flex:1;min-width:220px">
          <h1>${esc(doc.title)}</h1>
          <div class="meta">
            ${doc.subtitle ? `<span>${esc(doc.subtitle)}</span>` : ''}
            ${doc.start || doc.end ? `<span>📅 ${esc(dateRange(doc.start, doc.end))}</span>` : ''}
            ${doc.travellers?.length ? `<span>👥 ${doc.travellers.map(esc).join(', ')}</span>` : ''}
            ${countdown}
          </div>
        </div>
        <button class="btn sm" data-action="edit-plan">Edit details</button>
      </div>
      <nav class="tabs">${tabs}</nav>
      <div class="layout ${state.ai ? 'with-chat' : ''}">
        <div>${body}</div>
        ${state.ai ? chatPanel() : ''}
      </div>
    </main>
    ${state.ai ? `<button class="btn primary chat-fab" data-action="toggle-chat">✨ Ask / dump</button>` : ''}`;
  const log = document.querySelector('.chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function itemFacts(i, { showTab = false } = {}) {
  const facts = [];
  const range = dateRange(i.date, i.endDate);
  if (range) facts.push(`📅 ${esc(range)}${i.time ? ` · ${esc(i.time)}` : ''}`);
  else if (i.time) facts.push(`🕒 ${esc(i.time)}`);
  const where = [i.location, i.country].filter(Boolean).join(', ');
  if (where) facts.push(`📍 ${esc(where)}`);
  if (showTab) facts.push(`🗂️ ${esc(i.tabTitle)}`);
  return facts.length ? `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : '';
}

function priceHtml(i) {
  if (!i.price) return '';
  const hist = i.priceHistory || [];
  let trend = '';
  if (hist.length > 1) {
    const first = hist[0];
    if (first.currency === i.price.currency && first.amount !== i.price.amount) {
      const down = i.price.amount < first.amount;
      trend = ` <span class="trend ${down ? 'down' : 'up'}" title="Was ${esc(money(first))}">${down ? '↓' : '↑'} from ${esc(money(first))}</span>`;
    }
  }
  return `<div><span class="price">${esc(money(i.price))}</span>${i.price.note ? ` <span class="small muted">${esc(i.price.note)}</span>` : ''}${trend}</div>`;
}

const statusPill = (s) => `<span class="status ${esc(s)}">${esc(s)}</span>`;
const linksHtml = (links = []) => (links.length ? `<div class="links">${links.map((l) => `<a class="link-chip" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" data-stop>${esc(l.label || l.url.replace(/^https?:\/\/(www\.)?/, ''))}</a>`).join('')}</div>` : '');
const tagsHtml = (tags = []) => (tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '');
function detailsHtml(d = {}) {
  const e = Object.entries(d);
  return e.length ? `<dl class="kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}

function card(i, opts = {}) {
  return `<article class="card ${i.status === 'rejected' ? 'rejected' : ''}" data-item="${esc(i.id)}">
    ${i.image ? `<div class="img" style="background-image:url('${esc(safeUrl(i.image))}')"></div>` : ''}
    ${i.pinned ? '<span class="pin" title="Pinned">📌</span>' : ''}
    <div class="card-top">
      <div class="kind">${KINDS[i.kind] || '✨'}</div>
      <div style="flex:1;min-width:0">
        <h3>${esc(i.title)}</h3>
        ${i.subtitle ? `<div class="sub">${esc(i.subtitle)}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusPill(i.status)}${priceHtml(i)}</div>
    ${itemFacts(i, opts)}
    ${detailsHtml(i.details)}
    ${i.description ? `<div class="desc-text">${md(i.description)}</div>` : ''}
    ${linksHtml(i.links)}
    ${tagsHtml(i.tags)}
  </article>`;
}

function sortItems(items) {
  return [...items].sort((a, b) => (b.pinned - a.pinned));
}

function filterItems(items) {
  if (state.filter === 'all') return items.filter((i) => i.status !== 'rejected' || items.every((x) => x.status === 'rejected'));
  if (state.filter === 'everything') return items;
  return items.filter((i) => i.status === state.filter);
}

function tabView(tab) {
  const present = new Set(tab.items.map((i) => i.status));
  const chips = [
    ['all', 'Active'], ...STATUSES.filter((s) => present.has(s)).map((s) => [s, s[0].toUpperCase() + s.slice(1)]), ['everything', 'Everything'],
  ];
  const items = sortItems(filterItems(tab.items));
  let content;
  if (!tab.items.length) {
    content = `<div class="empty"><div class="big">${esc(tab.emoji || '🗂️')}</div><p>Nothing here yet.</p>
      <button class="btn primary" data-action="add-item" data-tab="${tab.id}">＋ Add something</button></div>`;
  } else if (!items.length) {
    content = '<div class="empty">Nothing matches this filter.</div>';
  } else {
    content = ({ cards: cardsLayout, table: tableLayout, timeline: timelineLayout, list: listLayout, notes: notesLayout }[tab.layout] || cardsLayout)(items);
  }
  return `<div class="tab-head">
      <h2>${esc(tab.emoji)} ${esc(tab.title)}</h2>
      <div class="spacer"></div>
      <select data-action="layout" data-tab="${tab.id}" aria-label="Layout" style="width:auto;padding:5px 8px;font-size:13px">
        ${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${tab.layout === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <button class="btn sm" data-action="edit-tab" data-tab="${tab.id}">Edit tab</button>
      <button class="btn primary sm" data-action="add-item" data-tab="${tab.id}">＋ Add</button>
      ${tab.description ? `<div class="desc">${md(tab.description)}</div>` : ''}
    </div>
    ${tab.items.length > 1 ? `<div class="filters" style="margin-bottom:14px">${chips.map(([k, l]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-action="filter" data-filter="${k}">${esc(l)}</button>`).join('')}</div>` : ''}
    ${content}`;
}

const cardsLayout = (items) => `<div class="cards">${items.map((i) => card(i)).join('')}</div>`;

function tableLayout(items) {
  const has = (k) => items.some((i) => (k === 'details' ? Object.keys(i.details || {}).length : i[k] && (!Array.isArray(i[k]) || i[k].length)));
  const detailKeys = [...new Set(items.flatMap((i) => Object.keys(i.details || {})))].slice(0, 4);
  const cols = [
    ['Item', (i) => `<div style="display:flex;gap:8px;align-items:center"><span>${KINDS[i.kind] || ''}</span><div><strong>${esc(i.title)}</strong>${i.subtitle ? `<div class="small muted">${esc(i.subtitle)}</div>` : ''}</div></div>`],
    has('date') && ['When', (i) => `${esc(dateRange(i.date, i.endDate))}${i.time ? `<div class="small muted">${esc(i.time)}</div>` : ''}`],
    (has('location') || has('country')) && ['Where', (i) => esc([i.location, i.country].filter(Boolean).join(', '))],
    ...detailKeys.map((k) => [k, (i) => esc(i.details?.[k] || '')]),
    has('price') && ['Price', (i) => priceHtml(i), 'num'],
    ['Status', (i) => statusPill(i.status)],
    has('links') && ['Links', (i) => linksHtml(i.links)],
  ].filter(Boolean);
  return `<div class="table-wrap"><table class="items">
    <thead><tr>${cols.map(([h, , c]) => `<th class="${c || ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${items.map((i) => `<tr data-item="${esc(i.id)}">${cols.map(([, f, c]) => `<td class="${c || ''}">${f(i)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function timelineLayout(items, { showTab = false } = {}) {
  const dated = items.filter((i) => i.date).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  const undated = items.filter((i) => !i.date);
  const groups = new Map();
  for (const i of dated) {
    const key = i.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const row = (i) => `<div class="tl-item" data-item="${esc(i.id)}">
      <div class="tl-date">${i.date ? esc(i.date.length === 7 ? 'Sometime' : fmtDate(i.date, { short: true })) : ''}${i.endDate ? `<div class="small muted">→ ${esc(fmtDate(i.endDate, { short: true }))}</div>` : ''}</div>
      <div class="tl-body">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span>${KINDS[i.kind] || ''}</span><strong>${esc(i.title)}</strong>${statusPill(i.status)}${priceHtml(i)}</div>
        ${i.subtitle ? `<div class="small muted">${esc(i.subtitle)}</div>` : ''}
        <div class="small muted">${esc([i.time, i.location, i.country, showTab ? i.tabTitle : ''].filter(Boolean).join(' · '))}</div>
      </div>
    </div>`;
  return `<div class="timeline">
    ${[...groups].map(([k, list]) => `<section class="month"><h3>${esc(fmtDate(k))}<span class="small muted">${list.length}</span></h3><div class="tl">${list.map(row).join('')}</div></section>`).join('')}
    ${undated.length ? `<section class="month"><h3>No date yet <span class="small muted">${undated.length}</span></h3><div class="tl">${undated.map(row).join('')}</div></section>` : ''}
  </div>`;
}

function listLayout(items) {
  return `<div class="checklist">${items.map((i) => `
    <div class="check-row ${i.status === 'done' ? 'done' : ''}">
      <input type="checkbox" data-action="toggle-done" data-item="${esc(i.id)}" ${i.status === 'done' ? 'checked' : ''} aria-label="Done">
      <div class="body" data-item="${esc(i.id)}">
        <div class="title"><strong>${esc(i.title)}</strong>${i.date ? ` <span class="small muted">· by ${esc(fmtDate(i.date, { short: true }))}</span>` : ''}${i.price ? ` · ${priceHtml(i).replace(/<\/?div>/g, '')}` : ''}</div>
        ${i.subtitle || i.description ? `<div class="small muted">${esc(i.subtitle || '')}${i.description ? md(i.description) : ''}</div>` : ''}
        ${linksHtml(i.links)}
      </div>
    </div>`).join('')}</div>`;
}

function notesLayout(items) {
  return `<div class="notes">${items.map((i) => `
    <article class="note" data-item="${esc(i.id)}">
      <h3>${KINDS[i.kind] || ''} ${esc(i.title)}</h3>
      ${i.subtitle ? `<div class="muted small" style="margin-bottom:6px">${esc(i.subtitle)}</div>` : ''}
      <div class="desc-text">${md(i.description)}</div>
      ${linksHtml(i.links)}
      ${tagsHtml(i.tags)}
    </article>`).join('')}</div>`;
}

// ---------- overview ----------
function overview(doc) {
  const items = allItems(doc);
  if (!items.length && !doc.summary) {
    return `<div class="empty" style="margin-top:20px"><div class="big">🌍</div>
      <p><strong>A blank page, full of possibility.</strong></p>
      <p>${state.ai ? 'Dump anything into the assistant: flights you\'ve spotted, countries you fancy, things to do. It will sort them into tabs.' : 'Add a tab and start dropping ideas in.'}</p></div>`;
  }
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  const live = items.filter((i) => i.status !== 'rejected');
  const totals = {};
  for (const i of items) {
    if (!i.price || !['booked', 'done'].includes(i.status)) continue;
    totals[i.price.currency] = (totals[i.price.currency] || 0) + i.price.amount;
  }
  const shortTotals = {};
  for (const i of items) {
    if (!i.price || i.status !== 'shortlisted') continue;
    shortTotals[i.price.currency] = (shortTotals[i.price.currency] || 0) + i.price.amount;
  }
  const fmtTotals = (t) => Object.entries(t).map(([c, a]) => money({ amount: a, currency: c })).join(' + ') || '—';
  const countries = {};
  for (const i of live) if (i.country) countries[i.country] = (countries[i.country] || 0) + 1;
  const pinned = items.filter((i) => i.pinned);
  const dated = live.filter((i) => i.date && ['booked', 'shortlisted', 'done'].includes(i.status));
  const colors = { idea: 'var(--st-idea)', considering: 'var(--st-considering)', shortlisted: 'var(--st-shortlisted)', booked: 'var(--st-booked)', done: 'var(--st-done)', rejected: 'var(--st-rejected)' };

  return `
    ${doc.summary ? `<div class="summary-box desc-text" style="margin-top:18px">${md(doc.summary)}</div>` : ''}
    <div class="ov-grid">
      <div class="stat"><div class="n">${live.length}</div><div class="l">Things in the plan</div></div>
      <div class="stat"><div class="n">${byStatus.booked + byStatus.done}</div><div class="l">Booked</div></div>
      <div class="stat"><div class="n" style="font-size:22px">${esc(fmtTotals(totals))}</div><div class="l">Spent / booked</div></div>
      <div class="stat"><div class="n" style="font-size:22px">${esc(fmtTotals(shortTotals))}</div><div class="l">Shortlisted, not booked</div></div>
    </div>
    ${items.length ? `<div class="status-bar">${STATUSES.filter((s) => byStatus[s]).map((s) => `<span style="width:${(byStatus[s] / items.length) * 100}%;background:${colors[s]}" title="${s}: ${byStatus[s]}"></span>`).join('')}</div>
    <div class="legend">${STATUSES.filter((s) => byStatus[s]).map((s) => `<span><i style="background:${colors[s]}"></i>${s} ${byStatus[s]}</span>`).join('')}</div>` : ''}
    ${Object.keys(countries).length ? `<h2 class="section-title">🌍 Countries</h2><div class="country-chips">${Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<span class="country">${esc(c)}<small>${n}</small></span>`).join('')}</div>` : ''}
    ${pinned.length ? `<h2 class="section-title">📌 Pinned</h2><div class="cards">${pinned.map((i) => card(i, { showTab: true })).join('')}</div>` : ''}
    ${dated.length ? `<h2 class="section-title">🧭 Itinerary so far</h2><p class="small muted" style="margin-top:-6px">Shortlisted and booked things with dates, across every tab.</p>${timelineLayout(dated, { showTab: true })}` : ''}
    <h2 class="section-title">🗂️ Tabs</h2>
    <div class="cards">${doc.tabs.map((t) => `<a class="card" style="text-decoration:none;color:inherit" href="#/p/${state.plan.id}/t/${t.id}">
      <div class="card-top"><div class="kind">${esc(t.emoji || '🗂️')}</div><div><h3>${esc(t.title)}</h3><div class="sub">${t.items.length} item${t.items.length === 1 ? '' : 's'}</div></div></div>
      ${t.description ? `<div class="desc-text small">${md(t.description)}</div>` : ''}</a>`).join('')}</div>`;
}

// ---------- history ----------
function diffDocs(prev, next) {
  if (!prev) return ['<div class="add">Plan created</div>'];
  const out = [];
  for (const k of ['title', 'subtitle', 'emoji', 'start', 'end', 'summary']) {
    if ((prev[k] || '') !== (next[k] || '')) out.push(`<div class="chg">✎ Plan ${esc(k)} changed${k !== 'summary' ? `: <code>${esc(prev[k] || '—')}</code> → <code>${esc(next[k] || '—')}</code>` : ''}</div>`);
  }
  const pt = new Map(prev.tabs.map((t) => [t.id, t]));
  const nt = new Map(next.tabs.map((t) => [t.id, t]));
  for (const t of next.tabs) {
    if (!pt.has(t.id)) out.push(`<div class="add">＋ New tab <strong>${esc(t.emoji)} ${esc(t.title)}</strong></div>`);
    else {
      const o = pt.get(t.id);
      if (o.title !== t.title) out.push(`<div class="chg">✎ Tab renamed <code>${esc(o.title)}</code> → <code>${esc(t.title)}</code></div>`);
      if (o.layout !== t.layout) out.push(`<div class="chg">✎ ${esc(t.title)} layout → ${esc(t.layout)}</div>`);
    }
  }
  for (const t of prev.tabs) if (!nt.has(t.id)) out.push(`<div class="del">－ Removed tab <strong>${esc(t.title)}</strong></div>`);
  const pi = new Map(allItems(prev).map((i) => [i.id, i]));
  const ni = new Map(allItems(next).map((i) => [i.id, i]));
  for (const [id, i] of ni) {
    const o = pi.get(id);
    if (!o) { out.push(`<div class="add">＋ Added <strong>${esc(i.title)}</strong> <span class="muted">in ${esc(i.tabTitle)}</span></div>`); continue; }
    const changes = [];
    if (o.tabId !== i.tabId) changes.push(`moved to ${esc(i.tabTitle)}`);
    if (o.status !== i.status) changes.push(`status <code>${esc(o.status)}</code> → <code>${esc(i.status)}</code>`);
    if (JSON.stringify(o.price) !== JSON.stringify(i.price)) changes.push(`price <code>${esc(money(o.price) || '—')}</code> → <code>${esc(money(i.price) || '—')}</code>`);
    for (const k of ['title', 'subtitle', 'description', 'date', 'endDate', 'time', 'location', 'country', 'kind', 'pinned', 'image']) {
      if (k !== 'title' && (o[k] ?? '') !== (i[k] ?? '')) changes.push(esc(k));
    }
    if (o.title !== i.title) changes.push(`renamed from <code>${esc(o.title)}</code>`);
    for (const k of ['links', 'tags', 'details']) if (JSON.stringify(o[k]) !== JSON.stringify(i[k])) changes.push(k);
    if (changes.length) out.push(`<div class="chg">✎ <strong>${esc(i.title)}</strong>: ${changes.join(', ')}</div>`);
  }
  for (const [id, i] of pi) if (!ni.has(id)) out.push(`<div class="del">－ Removed <strong>${esc(i.title)}</strong> <span class="muted">from ${esc(i.tabTitle)}</span></div>`);
  return out.length ? out : ['<div class="muted">No visible changes</div>'];
}

function historyView(r) {
  const h = state.history;
  const sel = h.selected;
  const list = `<div class="versions">${h.versions.map((v) => `
      <div class="version" data-version="${v.n}" style="${sel && sel.n === v.n ? 'background:var(--surface-2)' : ''}">
        <div class="n">v${v.n}</div>
        <div><div>${esc(v.summary)}</div><div class="small muted">${esc(v.author)} · ${esc(ago(v.created_at))}</div></div>
        <span class="src ${esc(v.source)}">${esc(v.source === 'ai' ? 'AI' : v.source)}</span>
      </div>`).join('')}</div>`;
  if (!sel) {
    return `<div class="tab-head"><h2>🕘 History</h2><div class="desc">Every change is saved as a version. Pick one to see what changed, preview it, or bring it back.</div></div>${list}`;
  }
  return `<div class="tab-head">
      <a class="btn sm" href="#/p/${state.plan.id}/history">← All versions</a>
      <h2>Version ${sel.n}</h2>
      <div class="spacer"></div>
      ${sel.n !== h.current ? `<button class="btn primary sm" data-action="restore" data-version="${sel.n}">Restore this version</button>` : '<span class="small muted">This is the current version</span>'}
      <div class="desc">${esc(sel.summary)} · ${esc(sel.author)} · ${esc(new Date(sel.created_at).toLocaleString('en-GB'))}</div>
    </div>
    <h3 class="section-title" style="margin-top:4px">What changed</h3>
    <div class="summary-box diff">${diffDocs(sel.previous, sel.doc).join('')}</div>
    <h3 class="section-title">How the plan looked</h3>
    <div class="banner">👀 Read-only snapshot of v${sel.n}: “${esc(sel.doc.title)}”, ${sel.doc.tabs.length} tabs, ${allItems(sel.doc).length} items.</div>
    ${sel.doc.tabs.map((t) => `<h3 class="section-title">${esc(t.emoji)} ${esc(t.title)}</h3>${t.items.length ? `<div class="cards" style="pointer-events:none">${t.items.map((i) => card(i)).join('')}</div>` : '<div class="muted small">Empty</div>'}`).join('')}`;
}

// ---------- chat ----------
function chatPanel() {
  const hints = [
    'Here\'s a brain dump, please sort it into tabs: …',
    'Flight LHR → BKK on 3 March, £612 return each, link: …',
    'The Tokyo flight is now £540, update it',
    'Tidy up the Inbox and suggest a rough route',
  ];
  const msgs = state.chat.map((m) => m.role === 'user'
    ? `<div class="msg user"><div class="who">${esc(m.author)}</div>${esc(m.text)}</div>`
    : `<div class="msg assistant">${md(m.text)}${m.version ? `<div class="small"><a href="#/p/${state.plan.id}/history/${m.version}">See changes (v${m.version})</a></div>` : ''}</div>`).join('');
  return `<aside class="chat ${state.chatOpen ? 'open' : ''}">
    <div class="chat-head"><h3>✨ Assistant</h3><button class="icon-btn chat-close" data-action="toggle-chat" title="Close">✕</button></div>
    <div class="chat-log">
      ${msgs || `<div class="muted small">Tell me anything about this trip and I'll file it in the right place, make new tabs when needed, update prices, or answer questions about the plan.</div>
        <div class="chat-hints">${hints.map((h) => `<button class="hint" data-action="hint">${esc(h)}</button>`).join('')}</div>`}
      ${state.thinking ? `<div class="msg assistant thinking">Working on it<span class="dot-pulse"></span></div>` : ''}
    </div>
    <form class="chat-form" id="chat-form">
      <textarea name="message" placeholder="Dump ideas, paste links, ask for changes…" ${state.thinking ? 'disabled' : ''}>${esc(state.draft || '')}</textarea>
      <div class="row"><span class="small muted">⌘/Ctrl + Enter to send</span><button class="btn primary sm" ${state.thinking ? 'disabled' : ''}>Send</button></div>
    </form>
  </aside>`;
}

async function sendChat(message) {
  if (!message.trim() || state.thinking) return;
  const planId = state.plan.id;
  state.thinking = true;
  state.draft = '';
  state.chat.push({ role: 'user', author: name() || 'You', text: message });
  rerender();
  try {
    const res = await api(`/plans/${planId}/ai`, { body: { message } });
    if (state.plan?.id === planId) {
      state.plan.doc = res.doc;
      state.plan.version = res.version;
      state.chat = await api(`/plans/${planId}/chat`);
    }
    if (res.changes?.length) toast(`✨ ${res.changes.length} change${res.changes.length === 1 ? '' : 's'} saved`);
  } catch (err) {
    state.chat.push({ role: 'assistant', text: `⚠️ ${err.message}` });
  } finally {
    state.thinking = false;
    rerender();
  }
}

// ---------- modals ----------
function openModal(html, onMount) {
  $modal.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = $modal.firstElementChild;
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  onMount?.($modal.querySelector('.modal'));
  $modal.querySelector('form input, form textarea')?.focus();
}
const closeModal = () => { $modal.innerHTML = ''; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $modal.innerHTML) closeModal(); });

async function saveOps(ops, summary) {
  try {
    const res = await api(`/plans/${state.plan.id}/ops`, { body: { ops, summary } });
    state.plan.doc = res.doc;
    state.plan.version = res.version;
    return res;
  } catch (err) { toast(`⚠️ ${err.message}`); throw err; }
}

function itemDetail(id) {
  const found = findItem(id);
  if (!found) return;
  const { item: i, tab } = found;
  const hist = i.priceHistory || [];
  openModal(`
    <div class="modal-head"><div class="kind">${KINDS[i.kind] || '✨'}</div><div style="flex:1"><h2>${esc(i.title)}</h2>${i.subtitle ? `<div class="muted">${esc(i.subtitle)}</div>` : ''}</div><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusPill(i.status)}${priceHtml(i)}<span class="small muted">in ${esc(tab.title)}</span></div>
      ${i.image ? `<img src="${esc(safeUrl(i.image))}" alt="" style="width:100%;border-radius:12px;max-height:280px;object-fit:cover">` : ''}
      ${itemFacts(i)}
      ${detailsHtml(i.details)}
      ${i.description ? `<div class="desc-text">${md(i.description)}</div>` : ''}
      ${linksHtml(i.links)}
      ${tagsHtml(i.tags)}
      ${hist.length > 1 ? `<div><strong class="small">Price history</strong><div class="price-hist">${hist.map((p) => `<div><span>${esc(new Date(p.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</span><span>${esc(money(p))}</span></div>`).join('')}</div></div>` : ''}
      <div class="by">${i.addedBy ? `Added by ${esc(i.addedBy)} · ` : ''}updated ${esc(ago(i.updatedAt))}</div>
    </div>
    <div class="modal-foot">
      <div class="left"><button class="btn danger sm" data-act="delete">Delete</button></div>
      <select data-act="move" style="width:auto">${state.plan.doc.tabs.map((t) => `<option value="${t.id}" ${t.id === tab.id ? 'selected' : ''}>Move to: ${esc(t.title)}</option>`).join('')}</select>
      <button class="btn" data-act="pin">${i.pinned ? 'Unpin' : '📌 Pin'}</button>
      <button class="btn primary" data-act="edit">Edit</button>
    </div>`, (m) => {
    m.querySelector('[data-close]').onclick = closeModal;
    m.querySelector('[data-act=edit]').onclick = () => itemEditor({ item: i, tabId: tab.id });
    m.querySelector('[data-act=pin]').onclick = async () => { await saveOps([{ type: 'update_item', item_id: i.id, changes: { pinned: !i.pinned } }]); closeModal(); rerender(); };
    m.querySelector('[data-act=move]').onchange = async (e) => { await saveOps([{ type: 'move_item', item_id: i.id, to_tab_id: e.target.value }]); closeModal(); rerender(); toast('Moved'); };
    m.querySelector('[data-act=delete]').onclick = async (e) => {
      if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Really delete?'; return; }
      await saveOps([{ type: 'delete_item', item_id: i.id }]); closeModal(); rerender(); toast('Deleted (you can restore it from History)');
    };
  });
}

function itemEditor({ item = null, tabId }) {
  const i = item || { kind: 'idea', status: 'idea', links: [], details: {}, tags: [] };
  const linkRow = (l = {}) => `<div class="link-row"><input type="text" name="link_label" placeholder="Label" value="${esc(l.label)}"><input type="url" name="link_url" placeholder="https://…" value="${esc(l.url)}"><button type="button" class="icon-btn" data-remove>✕</button></div>`;
  const detailRow = ([k, v] = ['', '']) => `<div class="detail-row"><input type="text" name="d_key" placeholder="e.g. Baggage" value="${esc(k)}"><input type="text" name="d_val" placeholder="e.g. 23kg" value="${esc(v)}"><button type="button" class="icon-btn" data-remove>✕</button></div>`;
  openModal(`
    <form id="item-form">
      <div class="modal-head"><h2>${item ? 'Edit' : 'Add'} item</h2><button type="button" class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <label class="field">Title <input type="text" name="title" required value="${esc(i.title)}" placeholder="e.g. Kyoto, or LHR → HND"></label>
        <div class="grid-2">
          <label class="field">Kind <select name="kind">${Object.entries(KINDS).map(([k, e]) => `<option value="${k}" ${i.kind === k ? 'selected' : ''}>${e} ${k}</option>`).join('')}</select></label>
          <label class="field">Status <select name="status">${STATUSES.map((s) => `<option ${i.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        </div>
        <label class="field">Subtitle <input type="text" name="subtitle" value="${esc(i.subtitle)}" placeholder="Short extra line"></label>
        <div class="grid-3">
          <label class="field">From <input type="date" name="date" value="${esc(i.date?.length === 10 ? i.date : '')}"></label>
          <label class="field">To <input type="date" name="endDate" value="${esc(i.endDate?.length === 10 ? i.endDate : '')}"></label>
          <label class="field">Time <input type="text" name="time" value="${esc(i.time)}" placeholder="09:40 → 17:15"></label>
        </div>
        <div class="grid-2">
          <label class="field">Location <input type="text" name="location" value="${esc(i.location)}"></label>
          <label class="field">Country <input type="text" name="country" value="${esc(i.country)}"></label>
        </div>
        <div class="grid-3">
          <label class="field">Price <input type="number" step="0.01" name="price" value="${esc(i.price?.amount ?? '')}"></label>
          <label class="field">Currency <input type="text" name="currency" value="${esc(i.price?.currency || 'GBP')}" maxlength="3"></label>
          <label class="field">Price note <input type="text" name="price_note" value="${esc(i.price?.note)}" placeholder="per person"></label>
        </div>
        <label class="field">Notes <textarea name="description" placeholder="Anything. **bold** and - bullets work.">${esc(i.description)}</textarea></label>
        <div class="field">Links <div id="links" style="display:grid;gap:6px">${(i.links?.length ? i.links : [{}]).map(linkRow).join('')}</div><button type="button" class="btn sm" data-add="links" style="justify-self:start">＋ Link</button></div>
        <div class="field">Other details <div id="details" style="display:grid;gap:6px">${(Object.entries(i.details || {}).length ? Object.entries(i.details) : [['', '']]).map(detailRow).join('')}</div><button type="button" class="btn sm" data-add="details" style="justify-self:start">＋ Detail</button></div>
        <div class="grid-2">
          <label class="field">Tags <input type="text" name="tags" value="${esc((i.tags || []).join(', '))}" placeholder="beach, must-do"></label>
          <label class="field">Image URL <input type="url" name="image" value="${esc(i.image)}" placeholder="https://…"></label>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`, (m) => {
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
    m.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove]')) e.target.parentElement.remove();
      if (e.target.dataset.add === 'links') m.querySelector('#links').insertAdjacentHTML('beforeend', linkRow());
      if (e.target.dataset.add === 'details') m.querySelector('#details').insertAdjacentHTML('beforeend', detailRow());
    });
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const labels = f.getAll('link_label');
      const links = f.getAll('link_url').map((url, n) => ({ url: url.trim(), label: labels[n].trim() })).filter((l) => l.url);
      const vals = f.getAll('d_val');
      const details = Object.fromEntries(f.getAll('d_key').map((k, n) => [k.trim(), vals[n].trim()]).filter(([k, v]) => k && v));
      const priceStr = String(f.get('price')).trim();
      const keepMonth = (field) => f.get(field) || (i[field]?.length === 7 ? i[field] : '');
      const changes = {
        title: f.get('title').trim(), kind: f.get('kind'), status: f.get('status'), subtitle: f.get('subtitle'),
        date: keepMonth('date'), endDate: keepMonth('endDate'), time: f.get('time'), location: f.get('location'), country: f.get('country'),
        price: priceStr ? { amount: Number(priceStr), currency: f.get('currency') || 'GBP', note: f.get('price_note') } : null,
        description: f.get('description'), links, details,
        tags: String(f.get('tags')).split(',').map((t) => t.trim()).filter(Boolean), image: f.get('image'),
      };
      try {
        await saveOps([item ? { type: 'update_item', item_id: item.id, changes } : { type: 'add_item', tab_id: tabId, item: changes }]);
        closeModal(); rerender(); toast('Saved');
      } catch { /* toast shown */ }
    };
  });
}

function tabEditor(tab = null) {
  const others = state.plan.doc.tabs.filter((t) => t !== tab);
  openModal(`
    <form>
      <div class="modal-head"><h2>${tab ? 'Edit tab' : 'New tab'}</h2><button type="button" class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <div class="grid-2" style="grid-template-columns:90px 1fr">
          <label class="field">Emoji <input type="text" name="emoji" value="${esc(tab?.emoji || '🗂️')}" maxlength="8"></label>
          <label class="field">Name <input type="text" name="title" required value="${esc(tab?.title)}"></label>
        </div>
        <label class="field">Layout <select name="layout">${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${tab?.layout === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field">Description <textarea name="description" style="min-height:60px">${esc(tab?.description)}</textarea></label>
        ${tab && others.length ? `<div class="field">Delete this tab
          <div style="display:flex;gap:8px;flex-wrap:wrap">${tab.items.length ? `<select name="move_to" style="width:auto;flex:1">${others.map((t) => `<option value="${t.id}">Move its ${tab.items.length} items to ${esc(t.title)}</option>`).join('')}</select>` : ''}
          <button type="button" class="btn danger sm" data-del>Delete tab</button></div></div>` : ''}
        ${tab ? `<div class="field">Position <div style="display:flex;gap:6px"><button type="button" class="btn sm" data-move="-1">← Earlier</button><button type="button" class="btn sm" data-move="1">Later →</button></div></div>` : ''}
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`, (m) => {
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
    const form = m.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const fields = { title: f.title, emoji: f.emoji, layout: f.layout, description: f.description };
      const res = await saveOps([tab ? { type: 'update_tab', tab_id: tab.id, ...fields } : { type: 'add_tab', ...fields }]);
      closeModal();
      if (!tab) go(`#/p/${state.plan.id}/t/${res.results[0].id}`); else rerender();
    };
    m.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Really delete?'; return; }
      const moveTo = form.elements.move_to?.value;
      await saveOps([{ type: 'delete_tab', tab_id: tab.id, ...(moveTo ? { move_items_to_tab_id: moveTo } : {}) }]);
      closeModal(); go(`#/p/${state.plan.id}`);
    });
    m.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
      const ids = state.plan.doc.tabs.map((t) => t.id);
      const idx = ids.indexOf(tab.id);
      const to = idx + Number(b.dataset.move);
      if (to < 0 || to >= ids.length) return;
      [ids[idx], ids[to]] = [ids[to], ids[idx]];
      await saveOps([{ type: 'reorder_tabs', tab_ids: ids }]);
      rerender();
    }));
  });
}

function planEditor() {
  const d = state.plan.doc;
  openModal(`
    <form>
      <div class="modal-head"><h2>Plan details</h2><button type="button" class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <div class="grid-2" style="grid-template-columns:90px 1fr">
          <label class="field">Emoji <input type="text" name="emoji" value="${esc(d.emoji)}" maxlength="8"></label>
          <label class="field">Name <input type="text" name="title" required value="${esc(d.title)}"></label>
        </div>
        <label class="field">Tagline <input type="text" name="subtitle" value="${esc(d.subtitle)}" placeholder="3 months, 6 countries, no alarms"></label>
        <div class="grid-2">
          <label class="field">Starts <input type="date" name="start" value="${esc(d.start)}"></label>
          <label class="field">Ends <input type="date" name="end" value="${esc(d.end)}"></label>
        </div>
        <label class="field">Who's going (comma separated) <input type="text" name="travellers" value="${esc((d.travellers || []).join(', '))}"></label>
        <label class="field">Summary <textarea name="summary" placeholder="The big picture">${esc(d.summary)}</textarea></label>
        ${state.admin ? `<div class="field" style="border-top:1px solid var(--line);padding-top:14px">🔒 Plan password
          <div class="small muted" style="font-weight:400">${state.plan.hasPassword ? 'This plan has its own password. Share the link and that password to give someone access to this plan only.' : 'No plan password yet, so only the admin password opens this plan. Set one to share it.'}</div>
          <div style="display:flex;gap:8px"><input type="text" id="plan-password" placeholder="${state.plan.hasPassword ? 'New password' : 'Choose a password'}" autocomplete="off" style="flex:1">
          <button type="button" class="btn sm" data-set-password>${state.plan.hasPassword ? 'Change' : 'Set'}</button>
          ${state.plan.hasPassword ? '<button type="button" class="btn sm danger" data-clear-password>Remove</button>' : ''}</div>
          <div class="small muted" style="font-weight:400">Changing or removing it signs out everyone who used the old one.</div></div>` : ''}
      </div>
      <div class="modal-foot">
        <div class="left">${state.admin ? `<button type="button" class="btn sm" data-archive>${state.plans.find((p) => p.id === state.plan.id)?.archived ? 'Unarchive' : 'Archive plan'}</button>` : ''}</div>
        <button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button>
      </div>
    </form>`, (m) => {
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
    const form = m.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      await saveOps([{ type: 'set_plan_details', ...f, travellers: f.travellers.split(',').map((t) => t.trim()).filter(Boolean) }]);
      closeModal(); rerender();
    };
    const setPw = async (password) => {
      try {
        const r = await api(`/plans/${state.plan.id}/password`, { body: { password } });
        state.plan.hasPassword = r.hasPassword;
        toast(r.hasPassword ? 'Plan password saved' : 'Plan password removed');
        closeModal(); planEditor();
      } catch (err) { toast(`⚠️ ${err.message}`); }
    };
    m.querySelector('[data-set-password]')?.addEventListener('click', () => setPw(m.querySelector('#plan-password').value));
    m.querySelector('[data-clear-password]')?.addEventListener('click', (e) => {
      if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Really remove?'; return; }
      setPw('');
    });
    m.querySelector('[data-archive]')?.addEventListener('click', async () => {
      const archived = !state.plans.find((p) => p.id === state.plan.id)?.archived;
      await api(`/plans/${state.plan.id}/archive`, { body: { archived } });
      closeModal(); go('#/');
    });
  });
  api('/plans').then((p) => { state.plans = p; }).catch(() => {});
}

function newPlanModal() {
  openModal(`
    <form>
      <div class="modal-head"><h2>New plan</h2><button type="button" class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <div class="grid-2" style="grid-template-columns:90px 1fr">
          <label class="field">Emoji <input type="text" name="emoji" value="🌏" maxlength="8"></label>
          <label class="field">Name <input type="text" name="name" required placeholder="Sabbatical 2027"></label>
        </div>
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create</button></div>
    </form>`, (m) => {
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
    m.querySelector('[name=name]').focus();
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const plan = await api('/plans', { body: f });
      closeModal(); go(`#/p/${plan.id}`);
    };
  });
}

// ---------- events ----------
function rerender() {
  if (route().view === 'plan' && state.plan) {
    const ta = document.querySelector('.chat-form textarea');
    if (ta && !state.thinking) state.draft = ta.value;
    const scroll = window.scrollY;
    renderPlan(route());
    window.scrollTo(0, scroll);
  } else render();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action], [data-item], [data-version]');
  if (!el || e.target.closest('[data-stop]') || el.closest('#modal-root')) return;
  const a = el.dataset.action;
  if (!a && el.dataset.item && !el.matches('input')) return itemDetail(el.dataset.item);
  if (!a && el.dataset.version) return go(`#/p/${state.plan.id}/history/${el.dataset.version}`);
  switch (a) {
    case 'new-plan': return newPlanModal();
    case 'unlock': return renderLogin({ locked: true });
    case 'copy-link': {
      const link = `${location.origin}/#/p/${el.dataset.plan}`;
      try { await navigator.clipboard.writeText(link); toast('Link copied. Send the plan password separately.'); } catch { prompt('Copy this link:', link); }
      return undefined;
    }
    case 'set-password': {
      const input = document.querySelector(`[data-pw-input="${el.dataset.plan}"]`);
      const password = input.value;
      if (!password) { input.focus(); return toast('Type a password first'); }
      try {
        await api(`/plans/${el.dataset.plan}/password`, { body: { password } });
        toast('Password saved. Anyone using the old one is signed out of this plan.');
        return render();
      } catch (err) { return toast(`⚠️ ${err.message}`); }
    }
    case 'clear-password': {
      if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Really?'; return undefined; }
      await api(`/plans/${el.dataset.plan}/password`, { body: { password: '' } });
      toast('Password removed. Only the admin can open this plan now.');
      return render();
    }
    case 'archive': {
      await api(`/plans/${el.dataset.plan}/archive`, { body: { archived: el.dataset.archived !== '1' } });
      return render();
    }
    case 'add-tab': return tabEditor();
    case 'edit-tab': return tabEditor(state.plan.doc.tabs.find((t) => t.id === el.dataset.tab));
    case 'add-item': return itemEditor({ tabId: el.dataset.tab });
    case 'edit-plan': return planEditor();
    case 'filter': state.filter = el.dataset.filter; return rerender();
    case 'toggle-chat': state.chatOpen = !state.chatOpen; document.querySelector('.chat')?.classList.toggle('open', state.chatOpen); return undefined;
    case 'hint': {
      const ta = document.querySelector('.chat-form textarea');
      ta.value = el.textContent.replace(/…$/, ''); ta.focus(); return undefined;
    }
    case 'restore': {
      if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Click again to restore'; return undefined; }
      const res = await api(`/plans/${state.plan.id}/versions/${el.dataset.version}/restore`, { body: {} });
      state.plan.doc = res.doc; state.plan.version = res.version;
      toast(`Restored. That's saved as v${res.version}, so you can undo it too.`);
      return go(`#/p/${state.plan.id}/history`);
    }
    case 'rename-me': {
      const n = prompt('Your name (shown on things you add):', name());
      if (n != null) { setName(n.trim()); rerender(); }
      return undefined;
    }
    case 'theme': {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('lfg_theme', next); } catch { /* ignore */ }
      return undefined;
    }
    case 'logout': await api('/logout', { body: {} }); return renderLogin();
    default: return undefined;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.action === 'layout') {
    await saveOps([{ type: 'update_tab', tab_id: el.dataset.tab, layout: el.value }]);
    rerender();
  }
  if (el.dataset.action === 'toggle-done') {
    const found = findItem(el.dataset.item);
    await saveOps([{ type: 'update_item', item_id: el.dataset.item, changes: { status: el.checked ? 'done' : (found.item.status === 'done' ? 'idea' : found.item.status) } }]);
    rerender();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chat-form') return;
  e.preventDefault();
  sendChat(e.target.elements.message.value);
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('.chat-form textarea') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});

// Pick up changes made by the other person every 20s.
setInterval(async () => {
  if (document.hidden || !state.plan || route().view !== 'plan' || $modal.innerHTML || state.thinking) return;
  if (document.activeElement?.matches('textarea, input')) return;
  try {
    const p = await api(`/plans/${state.plan.id}`);
    if (p.version !== state.plan.version) {
      state.plan = p;
      if (state.ai) state.chat = await api(`/plans/${p.id}/chat`);
      if (route().tab === 'history') return render();
      rerender();
    }
  } catch { /* offline, try later */ }
}, 20000);

async function boot(fromLogin = false) {
  try {
    const t = localStorage.getItem('lfg_theme');
    if (t) document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
  try {
    const s = await fetch('/api/session');
    if (s.status === 401) return renderLogin();
    const session = await s.json();
    state.ai = session.ai;
    state.admin = session.admin;
    state.signedIn = true;
    if (state.admin && fromLogin && route().view === 'home') return go('#/admin');
    if (!name()) {
      const n = prompt('What should we call you? (shown on things you add)');
      if (n) setName(n.trim());
    }
    render();
  } catch {
    $app.innerHTML = '<div class="page"><div class="empty">Can\'t reach the server.</div></div>';
  }
}
boot();
