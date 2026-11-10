// LFG front end entry point: rendering, events, polling and start-up.
// Plain ES modules, no build step.

import { esc } from './lib/format.js';
import { toICS } from './lib/plan.js';
import {
  $app, state, hooks, STATUSES, lsGet, lsSet, name, setName, toast, api, apiStream, isSignedOut,
  saveOps, setPlanDoc, markSeen, undoToast, findItem, route, go, closeModal, requestClose, modalOpen,
  openMenu, closeMenu, menuOpen, download, slug,
} from './core.js';
import { loginView, homeView, adminView, planView, planBody, chatLog } from './views.js';
import { itemDetail, itemEditor, tabEditor, planEditor, newPlanModal, deletePlanModal, nameModal, copyModal } from './editors.js';

const errorPage = (message) => `<div class="page"><div class="empty"><div class="big">🧭</div><p>${esc(message)}</p><a class="btn" href="#/">Back to plans</a></div></div>`;

// ---------- rendering ----------
async function render() {
  const r = route();
  try {
    if (r.view === 'admin') {
      if (!state.admin) return go('#/');
      [state.plans, state.aiSettings] = await Promise.all([api('/plans'), api('/settings/assistant')]);
      document.title = 'Admin · LFG';
      $app.innerHTML = adminView();
      return undefined;
    }
    if (r.view === 'home') {
      state.plans = await api('/plans');
      document.title = 'LFG · Let\'s flipping go';
      $app.innerHTML = homeView();
      return undefined;
    }
    if (!state.plan || state.plan.id !== r.planId) {
      if (!$app.querySelector('.topbar')) $app.innerHTML = '<div class="loading" aria-label="Loading"></div>';
      const plan = await api(`/plans/${r.planId}`);
      const seen = lsGet(`lfg_seen_${plan.id}`);
      state.plan = plan;
      state.newSince = seen != null && seen < plan.version ? { from: seen, to: plan.version } : null;
      state.chat = [];
      state.history = null;
      markSeen();
      if (state.ai) api(`/plans/${plan.id}/chat`).then((chat) => { if (state.plan?.id === plan.id && !state.thinking) { state.chat = chat; refreshChat(); } }).catch(() => {});
    }
    if (r.tab === 'history') {
      const [list, selected] = await Promise.all([
        api(`/plans/${r.planId}/versions`),
        r.version ? api(`/plans/${r.planId}/versions/${r.version}`) : null,
      ]);
      state.history = { ...list, selected };
    }
    renderPlan(r);
  } catch (err) {
    if (!isSignedOut(err)) $app.innerHTML = errorPage(err.message);
  }
  return undefined;
}

function renderPlan(r) {
  document.title = `${state.plan.doc.title} · LFG`;
  $app.innerHTML = planView(r);
  scrollChat();
  $app.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Re-draws the current screen in place, keeping scroll position, the chat
// draft and the caret in the search or quick-add box.
function rerender() {
  if (route().view !== 'plan' || !state.plan) return render();
  const ta = document.querySelector('.chat-form textarea');
  if (ta && !state.thinking) state.draft = ta.value;
  const focused = ['search', 'quick-add'].includes(document.activeElement?.id) ? document.activeElement.id : null;
  const scroll = window.scrollY;
  renderPlan(route());
  window.scrollTo(0, scroll);
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  return undefined;
}

function renderLogin(opts) {
  closeModal();
  closeMenu();
  document.body.classList.remove('no-scroll');
  state.chatOpen = false;
  $app.innerHTML = loginView(opts);
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

Object.assign(hooks, { render, rerender, login: renderLogin });

// Only the body below the tabs changes while typing in the search box.
function refreshBody() {
  const body = document.getElementById('plan-body');
  if (!body) return;
  body.innerHTML = planBody(route());
  const r = route();
  document.querySelectorAll('.plan-nav .tab').forEach((t) => {
    const href = t.getAttribute('href');
    if (!href) return;
    const mine = r.tab === 'overview' ? href === `#/p/${r.planId}` : r.tab === 'history' ? href.endsWith('/history') : href.endsWith(`/t/${r.tab}`);
    t.classList.toggle('active', mine && !state.query.trim());
  });
}

// ---------- assistant ----------
function scrollChat() {
  const log = document.querySelector('.chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}
function refreshChat() {
  const log = document.querySelector('.chat-log');
  if (!log) return;
  log.innerHTML = chatLog();
  scrollChat();
}

function setChatOpen(open) {
  if (!document.querySelector('.chat-back')) return;
  state.chatOpen = open;
  document.querySelector('.chat-back').classList.toggle('open', open);
  document.body.classList.toggle('no-scroll', open);
  if (open) {
    scrollChat();
    document.querySelector('.chat-form textarea')?.focus();
  }
}

async function sendChat(message) {
  if (!message.trim() || state.thinking) return;
  const planId = state.plan.id;
  state.thinking = true;
  state.steps = [];
  state.draft = '';
  state.chat.push({ role: 'user', author: name() || 'You', text: message });
  rerender();
  try {
    const res = await apiStream(`/plans/${planId}/ai`, { message, stream: true }, (event) => {
      if (event.type === 'step') { state.steps.push(event.text); refreshChat(); }
    });
    if (state.plan?.id === planId) {
      setPlanDoc(res);
      state.chat = await api(`/plans/${planId}/chat`);
    }
    const n = res.changes?.length || 0;
    if (n && res.savedVersion) undoToast(`✨ ${n} change${n === 1 ? '' : 's'} saved`, res.savedVersion);
  } catch (err) {
    if (!isSignedOut(err)) state.chat.push({ role: 'assistant', text: `⚠️ ${err.message}` });
  } finally {
    state.thinking = false;
    state.steps = [];
    rerender();
  }
}

// ---------- actions ----------
function statusMenu(el) {
  const found = findItem(el.dataset.item);
  if (!found) return;
  openMenu(el, STATUSES.map((s) => ({
    html: `<span class="status ${s}">${s}</span>`,
    current: s === found.item.status,
    onClick: async () => {
      if (s === found.item.status) return;
      try {
        await saveOps([{ type: 'update_item', item_id: found.item.id, changes: { status: s } }]);
        rerender();
        if (modalOpen()) itemDetail(found.item.id);
      } catch { /* toast shown */ }
    },
  })));
}

function planMenu(el) {
  const { doc, id } = state.plan;
  openMenu(el, [
    { label: 'Edit details', icon: 'edit', onClick: planEditor },
    { label: 'History', icon: 'history', onClick: () => go(`#/p/${id}/history`) },
    'divider',
    { label: 'Add dates to my calendar (.ics)', icon: 'calendar', onClick: () => { download(`${slug(doc.title)}.ics`, toICS(doc), 'text/calendar'); toast('Calendar file downloaded'); } },
    { label: 'Download a backup (.json)', icon: 'download', onClick: () => download(`${slug(doc.title)}-v${state.plan.version}.json`, JSON.stringify(doc, null, 2), 'application/json') },
    { label: 'Print', icon: 'print', onClick: () => window.print() },
  ]);
}

async function copyLink(planId) {
  const link = `${location.origin}/#/p/${planId}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied. Send the plan password separately.');
  } catch { copyModal('Plan link', link); }
}

function setQuery(q) {
  state.query = q;
  const input = document.getElementById('search');
  if (input) input.value = q;
  refreshBody();
  window.scrollTo({ top: Math.min(window.scrollY, document.querySelector('.plan-nav')?.offsetTop ?? 0) });
}

// The stylesheet has one dark block keyed on data-theme, so the attribute is
// always set: to the saved choice, or else to whatever the system prefers.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const savedTheme = () => { try { return localStorage.getItem('lfg_theme'); } catch { return null; } };
function applyTheme() {
  document.documentElement.dataset.theme = savedTheme() || (systemDark.matches ? 'dark' : 'light');
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('lfg_theme', next); } catch { /* ignore */ }
  document.documentElement.dataset.theme = next;
}
systemDark.addEventListener('change', applyTheme);
applyTheme();

// Click actions, keyed by data-action. Each gets the element that carries it.
const actions = {
  'new-plan': () => newPlanModal(),
  unlock: () => renderLogin({ locked: true }),
  'copy-link': (el) => copyLink(el.dataset.plan),
  'clear-password': async (el) => {
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Really remove?'; return; }
    await api(`/plans/${el.dataset.plan}/password`, { body: { password: '' } });
    toast('Password removed. Only the admin can open this plan now.');
    await render();
  },
  archive: async (el) => {
    await api(`/plans/${el.dataset.plan}/archive`, { body: { archived: el.dataset.archived !== '1' } });
    await render();
  },
  'delete-plan': (el) => deletePlanModal(state.plans.find((p) => p.id === el.dataset.plan)),
  'add-tab': () => tabEditor(),
  'edit-tab': (el) => tabEditor(state.plan.doc.tabs.find((t) => t.id === el.dataset.tab)),
  'add-item': (el) => itemEditor({ tabId: el.dataset.tab, preset: presetFor(el.dataset.tab) }),
  'edit-plan': () => planEditor(),
  'plan-menu': (el) => planMenu(el),
  status: (el) => statusMenu(el),
  filter: (el) => { state.filter = el.dataset.filter; rerender(); },
  tag: (el) => setQuery(`#${el.dataset.tag}`),
  'search-for': (el) => setQuery(el.dataset.q),
  'clear-search': () => setQuery(''),
  'dismiss-since': () => { state.newSince = null; rerender(); },
  'toggle-chat': () => setChatOpen(!state.chatOpen),
  hint: (el) => {
    const ta = document.querySelector('.chat-form textarea');
    ta.value = el.textContent.replace(/…$/, '');
    ta.focus();
  },
  restore: async (el) => {
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = 'Click again to restore'; return; }
    const res = await api(`/plans/${state.plan.id}/versions/${el.dataset.version}/restore`, { body: {} });
    setPlanDoc(res);
    toast(`Restored. That's saved as v${res.version}, so you can undo it too.`);
    go(`#/p/${state.plan.id}/history`);
  },
  'older-versions': async () => {
    const h = state.history;
    const more = await api(`/plans/${state.plan.id}/versions?offset=${h.versions.length}`);
    h.versions.push(...more.versions);
    rerender();
  },
  'rename-me': () => nameModal(),
  theme: () => toggleTheme(),
  logout: async () => {
    await api('/logout', { body: {} });
    Object.assign(state, { plan: null, plans: [], admin: false, signedIn: false, chat: [] });
    renderLogin();
  },
};

// New items in a checklist tab start as to-dos; elsewhere they copy the kind
// the tab mostly holds.
function presetFor(tabId) {
  const tab = state.plan.doc.tabs.find((t) => t.id === tabId);
  if (!tab) return {};
  if (tab.layout === 'list') return { kind: 'todo' };
  if (tab.layout === 'notes') return { kind: 'note' };
  const counts = {};
  for (const i of tab.items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 ? { kind: top[0] } : {};
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  if (e.target.classList?.contains('chat-back')) return setChatOpen(false);
  if (e.target.closest('[data-stop]')) return undefined;
  const el = e.target.closest('[data-action], [data-item]');
  if (!el) return undefined;
  const a = el.dataset.action;
  // Inside a dialog only the status pill is handled here; the dialogs wire up
  // their own buttons.
  if (el.closest('#modal-root') && a !== 'status') return undefined;
  if (el.closest('.snapshot')) return undefined;
  if (!a) return el.matches('input') ? undefined : itemDetail(el.dataset.item);
  if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') e.preventDefault();
  try {
    await actions[a]?.(el);
  } catch (err) {
    if (!isSignedOut(err)) toast(`⚠️ ${err.message}`);
  }
  return undefined;
});

// Clicking a tab while searching leaves the search, even if it's the tab you were on.
document.addEventListener('click', (e) => {
  if (state.query && e.target.closest('.plan-nav a.tab')) { state.query = ''; setTimeout(rerender); }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.dataset.action === 'layout') {
      await saveOps([{ type: 'update_tab', tab_id: el.dataset.tab, layout: el.value }]);
      rerender();
    } else if (el.dataset.action === 'sort') {
      lsSet('lfg_sort', { ...lsGet('lfg_sort', {}), [el.dataset.tab]: el.value });
      rerender();
    } else if (el.dataset.action === 'toggle-done') {
      const found = findItem(el.dataset.item);
      if (!found) return;
      const status = el.checked ? 'done' : (found.item.status === 'done' ? 'idea' : found.item.status);
      await saveOps([{ type: 'update_item', item_id: el.dataset.item, changes: { status } }]);
      rerender();
    } else if (el.closest('#ai-settings') && el.name === 'model') {
      document.getElementById('model-note').textContent = state.aiSettings.models.find((m) => m.id === el.value)?.note || '';
    }
  } catch { rerender(); }
});

const forms = {
  'quick-add': async (form) => {
    const title = form.elements.title.value.trim();
    if (!title) return;
    form.elements.title.value = '';
    await saveOps([{ type: 'add_item', tab_id: form.dataset.tab, item: { kind: 'idea', status: 'idea', ...presetFor(form.dataset.tab), title } }]);
    rerender();
    document.getElementById('quick-add')?.focus({ preventScroll: true });
  },
  'set-password': async (form) => {
    const input = form.elements.password;
    if (!input.value) { input.focus(); toast('Type a password first'); return; }
    await api(`/plans/${form.dataset.plan}/password`, { body: { password: input.value } });
    toast('Password saved. Anyone using the old one is signed out of this plan.');
    await render();
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target;
  try {
    if (form.id === 'chat-form') {
      e.preventDefault();
      sendChat(form.elements.message.value);
    } else if (form.id === 'ai-settings') {
      e.preventDefault();
      const r = await api('/settings/assistant', { body: Object.fromEntries(new FormData(form)) });
      Object.assign(state.aiSettings, r);
      toast(`Assistant now uses ${state.aiSettings.models.find((m) => m.id === r.model)?.label} at ${r.effort} effort`);
    } else if (forms[form.dataset.form]) {
      e.preventDefault();
      await forms[form.dataset.form](form);
    }
  } catch (err) {
    if (!isSignedOut(err)) toast(`⚠️ ${err.message}`);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.query = e.target.value;
  refreshBody();
});

const typing = (el) => el?.matches?.('input, textarea, select, [contenteditable]');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (menuOpen()) closeMenu();
    else if (modalOpen()) requestClose();
    else if (state.chatOpen) setChatOpen(false);
    else if (e.target.id === 'search' && state.query) setQuery('');
    else if (typing(e.target)) e.target.blur();
    return;
  }
  if (e.target.matches?.('.chat-form textarea') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendChat(e.target.value);
    return;
  }
  // Cards, rows and notes open with Enter or Space like buttons do.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-item][tabindex]')) {
    e.preventDefault();
    itemDetail(e.target.dataset.item);
    return;
  }
  if (typing(e.target) || modalOpen() || state.chatOpen || e.metaKey || e.ctrlKey || e.altKey || route().view !== 'plan' || !state.plan) return;
  const r = route();
  if (e.key === '/') { e.preventDefault(); document.getElementById('search')?.focus(); }
  else if (e.key === 'a' && state.ai) { e.preventDefault(); setChatOpen(true); }
  else if (e.key === 'n' && state.plan.doc.tabs.some((t) => t.id === r.tab)) { e.preventDefault(); actions['add-item']({ dataset: { tab: r.tab } }); }
});

// A broken image address shouldn't leave an empty box, or white text on nothing.
document.addEventListener('error', (e) => {
  if (!e.target.matches?.('.card-img, .detail-img, .hero-cover, .plan-cover')) return;
  e.target.parentElement.classList.remove('has-cover');
  e.target.remove();
}, true);

// ---------- drag and drop ----------
// Drag an item to reorder it within its tab, or onto a tab to move it there.
// Drag a tab to reorder the tabs. (Mouse only: touch screens don't send these.)
let drag = null; // { type: 'item' | 'tab', id }
const dragId = (el) => el?.dataset.dragItem || el?.dataset.item;
const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));

// Where a drop would land: on a tab pill, or before/after another item.
function dropTarget(e) {
  const tab = e.target.closest?.('.tabs a.tab[data-tab-id]');
  if (tab) return { tab };
  if (drag?.type !== 'item') return null;
  const el = e.target.closest?.('[draggable="true"]');
  if (!el || !dragId(el) || dragId(el) === drag.id) return null;
  const r = el.getBoundingClientRect();
  // Cards sit side by side, so use left/right there and top/bottom in lists.
  const sideways = el.classList.contains('card') && el.parentElement.children.length > 1 && r.width < el.parentElement.clientWidth * 0.9;
  const after = sideways ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  return { el, after };
}

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[draggable="true"]');
  if (!el) return;
  drag = el.dataset.tabId ? { type: 'tab', id: el.dataset.tabId } : { type: 'item', id: dragId(el) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.id);
  el.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  if (!drag) return;
  const t = dropTarget(e);
  clearDrop();
  if (!t) return;
  if (t.tab && t.tab.dataset.tabId === (drag.type === 'tab' ? drag.id : findItem(drag.id)?.tab.id)) return;
  e.preventDefault();
  if (t.tab) t.tab.classList.add(drag.type === 'item' ? 'drop-into' : 'drop-before');
  else t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
});
document.addEventListener('dragend', () => {
  drag = null;
  clearDrop();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
});
document.addEventListener('drop', async (e) => {
  const d = drag;
  const t = d && dropTarget(e);
  if (!t) return;
  e.preventDefault();
  try {
    const { tabs } = state.plan.doc;
    if (t.tab && d.type === 'tab') {
      const ids = tabs.map((x) => x.id).filter((id) => id !== d.id);
      ids.splice(ids.indexOf(t.tab.dataset.tabId), 0, d.id);
      await saveOps([{ type: 'reorder_tabs', tab_ids: ids }]);
    } else if (t.tab) {
      const dest = tabs.find((x) => x.id === t.tab.dataset.tabId);
      if (!dest || findItem(d.id)?.tab === dest) return;
      const res = await saveOps([{ type: 'move_item', item_id: d.id, to_tab_id: dest.id }]);
      undoToast(`Moved to ${dest.title}`, res.version);
    } else {
      const { tab } = findItem(d.id);
      const rest = tab.items.filter((i) => i.id !== d.id);
      const at = rest.findIndex((i) => i.id === dragId(t.el));
      if (at < 0) return;
      await saveOps([{ type: 'move_item', item_id: d.id, to_tab_id: tab.id, position: at + (t.after ? 1 : 0) }]);
    }
    rerender();
  } catch { /* toast shown */ }
});

window.addEventListener('hashchange', () => {
  state.filter = 'all';
  state.query = '';
  closeMenu();
  if (modalOpen()) closeModal();
  if (state.chatOpen) setChatOpen(false);
  window.scrollTo(0, 0);
  render();
});

// Pick up changes made by other people every 20s, and straight away on
// coming back to the tab.
async function poll() {
  if (document.hidden || !state.plan || route().view !== 'plan' || modalOpen() || menuOpen() || state.thinking) return;
  if (typing(document.activeElement) && document.activeElement.value) return;
  try {
    const p = await api(`/plans/${state.plan.id}`);
    if (!state.plan || p.id !== state.plan.id || p.version === state.plan.version) return;
    state.plan = p;
    markSeen();
    if (state.ai) state.chat = await api(`/plans/${p.id}/chat`);
    if (route().tab === 'history') await render(); else rerender();
    toast('Updated with someone else\'s changes');
  } catch { /* offline, try later */ }
}
setInterval(poll, 20000);
document.addEventListener('visibilitychange', poll);

async function boot(fromLogin = false) {
  try {
    const s = await fetch('/api/session');
    if (s.status === 401) return renderLogin();
    if (!s.ok) throw new Error('bad response');
    const session = await s.json();
    state.ai = session.ai;
    state.admin = session.admin;
    state.signedIn = true;
    if (state.admin && fromLogin && route().view === 'home') return go('#/admin');
    await render();
    if (!name()) nameModal({ first: true });
  } catch {
    $app.innerHTML = '<div class="page"><div class="empty"><div class="big">📡</div><p>Can\'t reach the server.</p><button class="btn" data-action="reload">Try again</button></div></div>';
  }
  return undefined;
}
actions.reload = () => location.reload();
boot();
