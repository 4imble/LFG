// HTML builders for every screen. These only read state and return strings;
// behaviour lives in app.js (events) and editors.js (dialogs).

import { esc, safeUrl, md, money, plural, hostOf, fmtDate, dateRange, shortRange, nights, ago, todayStr, daysBetween, isFullDate } from './lib/format.js';
import { allItems, searchItems, sortItems, SORTS, totals, spendByKind, fmtTotals, tripPhase, tripDay, isPerPerson, budgetUse, stayCoverage, tripStrip, nextUp } from './lib/plan.js';
import { diffDocs } from './lib/diff.js';
import { state, KINDS, STATUSES, LAYOUTS, icon, name, lsGet } from './core.js';

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const kindIcon = (k) => KINDS[k] || '✨';

// ---------- login ----------
export function loginView({ locked = false } = {}) {
  return `
    <div class="login">
      <form class="login-card" id="login">
        <div class="login-mark">🧭</div>
        <div><h1>LFG<span class="dot">.</span></h1>
        <p class="muted">${locked ? 'This plan has its own password. Enter it to open the plan.' : 'Let\'s flipping go. Enter the password you were given.'}</p></div>
        <label class="field">Your name <input type="text" name="name" value="${esc(name())}" placeholder="So we know who added what" autocomplete="nickname" maxlength="40"></label>
        <label class="field">Password <input type="password" name="password" required autofocus autocomplete="current-password"></label>
        <div class="error" id="login-error" role="alert"></div>
        <button class="btn primary lg">${locked ? 'Unlock' : 'Let\'s go'}</button>
        ${state.signedIn ? '<a class="btn ghost" href="#/">Back to my plans</a>' : ''}
      </form>
    </div>`;
}

// ---------- top bar ----------
export function topbar() {
  return `<header class="topbar">
    <a class="brand" href="#/" aria-label="LFG, all plans">LFG<span>.</span></a>
    <div class="spacer"></div>
    ${state.admin ? `<a class="btn ghost sm" href="#/admin">${icon('sliders')}<span class="hide-s">Admin</span></a>` : ''}
    <button class="btn ghost sm who" data-action="rename-me" title="Change your name">${icon('user')}<span>${esc(name() || 'Set your name')}</span></button>
    <button class="icon-btn" data-action="theme" title="Switch between light and dark" aria-label="Switch between light and dark">${icon('moon')}</button>
    <button class="icon-btn" data-action="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
  </header>`;
}

function countdownChip(start, end) {
  const phase = tripPhase({ start, end }, todayStr());
  if (!phase) return '';
  if (phase.phase === 'before') return `<span class="countdown">${plural(phase.days, 'day')} to go</span>`;
  if (phase.phase === 'during') return `<span class="countdown now">Day ${phase.day} of ${phase.length}</span>`;
  return '';
}

// ---------- home ----------
export function homeView() {
  const active = state.plans.filter((p) => !p.archived);
  const archived = state.plans.filter((p) => p.archived);
  const card = (p) => `
    <a class="plan-card ${p.cover ? 'has-cover' : ''}" href="#/p/${p.id}">
      ${p.cover ? `<img class="plan-cover" src="${esc(safeUrl(p.cover))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="plan-card-top"><div class="emoji">${esc(p.emoji || '🧭')}</div>${countdownChip(p.start, p.end)}</div>
      <h2>${esc(p.title)}</h2>
      ${p.subtitle ? `<div class="muted">${esc(p.subtitle)}</div>` : ''}
      <div class="plan-card-foot">
        ${p.itemCount ? `<div class="bar" title="${p.bookedCount} of ${p.itemCount} booked"><span style="width:${(p.bookedCount / p.itemCount) * 100}%"></span></div>` : ''}
        <div class="small muted">${[dateRange(p.start, p.end), p.itemCount ? `${p.bookedCount} of ${plural(p.itemCount, 'item')} booked` : 'Nothing in it yet', `updated ${ago(p.updated_at)}`].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </a>`;
  return `${topbar()}
    <main class="page">
      <section class="hero"><h1>Where next?</h1><p class="muted">Every trip gets its own plan. Dump ideas in${state.ai ? ', and the assistant keeps them tidy' : ' and shape them as you go'}.</p></section>
      <div class="plan-grid">
        ${active.map(card).join('')}
        ${state.admin
    ? `<button class="plan-card new" data-action="new-plan"><div class="emoji">${icon('plus')}</div><div>New plan</div></button>`
    : `<button class="plan-card new" data-action="unlock"><div class="emoji">${icon('lock')}</div><div>Open another plan with its password</div></button>`}
      </div>
      ${archived.length ? `<h2 class="section-title">Archived</h2><div class="plan-grid archived">${archived.map(card).join('')}</div>` : ''}
    </main>`;
}

// ---------- admin ----------
export function adminView() {
  const row = (p) => `
    <div class="admin-row ${p.archived ? 'archived' : ''}">
      <a class="admin-plan" href="#/p/${p.id}"><span class="emoji">${esc(p.emoji || '🧭')}</span>
        <span><strong>${esc(p.title)}</strong><div class="small muted">${[dateRange(p.start, p.end), plural(p.itemCount, 'item'), `updated ${ago(p.updated_at)}`, p.archived ? 'archived' : ''].filter(Boolean).map(esc).join(' · ')}</div></span></a>
      <div class="admin-pw">
        <span class="small pw-state ${p.hasPassword ? 'on' : 'muted'}">${icon('lock')}${p.hasPassword ? 'Has a password' : 'No password, so only you can open it'}</span>
        <form class="pw-form" data-form="set-password" data-plan="${p.id}">
          <input type="text" name="password" placeholder="${p.hasPassword ? 'New password' : 'Set a password'}" autocomplete="off" aria-label="Password for ${esc(p.title)}" minlength="6">
          <button class="btn sm">${p.hasPassword ? 'Reset' : 'Set'}</button>
          ${p.hasPassword ? `<button type="button" class="btn sm danger" data-action="clear-password" data-plan="${p.id}">Remove</button>` : ''}
        </form>
      </div>
      <div class="admin-actions">
        <button class="btn sm" data-action="copy-link" data-plan="${p.id}">${icon('link')}Copy link</button>
        <button class="btn sm ghost" data-action="archive" data-plan="${p.id}" data-archived="${p.archived ? 1 : 0}">${p.archived ? 'Unarchive' : 'Archive'}</button>
        <button class="btn sm ghost danger" data-action="delete-plan" data-plan="${p.id}">Delete</button>
      </div>
    </div>`;
  return `${topbar()}
    <main class="page">
      <section class="hero split">
        <div><h1>Admin</h1>
        <p class="muted">Every plan, its password and its link. To share a plan, copy its link and send its password separately. Whoever has both can see and edit that plan, and nothing else.</p></div>
        <button class="btn primary" data-action="new-plan">${icon('plus')}New plan</button>
      </section>
      <div class="admin-list">${state.plans.length ? state.plans.map(row).join('') : '<div class="empty">No plans yet. Create the first one.</div>'}</div>
      ${assistantSettings()}
    </main>`;
}

function assistantSettings() {
  const a = state.aiSettings;
  if (!a) return '';
  const effortNotes = { low: 'Quick, cheapest', medium: 'Balanced (default)', high: 'Thinks harder', xhigh: 'Thinks hardest, slowest' };
  return `<h2 class="section-title">${icon('sparkles')}Assistant</h2>
    <form class="panel form-grid" id="ai-settings">
      ${a.enabled ? '' : '<div class="banner">The assistant is off because <code>ANTHROPIC_API_KEY</code> isn\'t set. You can still choose these settings now.</div>'}
      <div class="grid-2">
        <label class="field">Model
          <select name="model">${a.models.map((m) => `<option value="${esc(m.id)}" ${m.id === a.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
          <span class="hint-text" id="model-note">${esc(a.models.find((m) => m.id === a.model)?.note || '')}</span>
        </label>
        <label class="field">Effort
          <select name="effort">${a.efforts.map((e) => `<option value="${e}" ${e === a.effort ? 'selected' : ''}>${e} · ${effortNotes[e] || ''}</option>`).join('')}</select>
          <span class="hint-text">Higher effort gives better reorganising and research, but replies take longer and cost more.</span>
        </label>
      </div>
      <div class="small muted">Prices are per million tokens (input / output). A typical request costs pennies on Opus or Sonnet. These settings apply to every plan.</div>
      <div><button class="btn primary sm">Save assistant settings</button></div>
    </form>`;
}

// ---------- plan shell ----------
export function planView(r) {
  const { doc } = state.plan;
  const phase = tripPhase(doc, todayStr());
  const length = isFullDate(doc.start) && isFullDate(doc.end) ? daysBetween(doc.start, doc.end) + 1 : 0;
  const tabs = [
    `<a class="tab ${r.tab === 'overview' && !state.query ? 'active' : ''}" href="#/p/${state.plan.id}">Overview</a>`,
    ...doc.tabs.map((t) => `<a class="tab ${r.tab === t.id && !state.query ? 'active' : ''}" draggable="true" data-tab-id="${t.id}" href="#/p/${state.plan.id}/t/${t.id}">${t.emoji ? `<span class="tab-emoji">${esc(t.emoji)}</span>` : ''}${esc(t.title)}<span class="count">${t.items.length}</span></a>`),
    `<button class="tab add" data-action="add-tab" title="Add a tab" aria-label="Add a tab">${icon('plus')}</button>`,
  ].join('');

  return `${topbar()}
    <main class="page wide">
      <section class="plan-hero ${doc.cover ? 'has-cover' : ''}">
        ${doc.cover ? `<img class="hero-cover" src="${esc(safeUrl(doc.cover))}" alt="" referrerpolicy="no-referrer">` : ''}
        <div class="hero-emoji">${esc(doc.emoji || '🧭')}</div>
        <div class="hero-main">
          <h1>${esc(doc.title)}</h1>
          ${doc.subtitle ? `<p class="tagline">${esc(doc.subtitle)}</p>` : ''}
          <div class="meta">
            ${doc.start || doc.end ? `<span class="meta-chip">${icon('calendar')}${esc(dateRange(doc.start, doc.end))}${length ? ` · ${plural(length, 'day')}` : ''}</span>` : ''}
            ${doc.travellers?.length ? `<span class="meta-chip">${icon('users')}${doc.travellers.map(esc).join(', ')}</span>` : ''}
            ${countdownChip(doc.start, doc.end)}
            ${state.plan.archived ? '<span class="meta-chip">Archived</span>' : ''}
          </div>
        </div>
        <div class="hero-actions">
          <button class="btn" data-action="edit-plan">${icon('edit')}<span class="hide-s">Edit details</span></button>
          <button class="btn icon-only" data-action="plan-menu" aria-label="More actions" title="More actions">${icon('more')}</button>
        </div>
        ${phase?.phase === 'during' ? `<div class="trip-progress" title="Day ${phase.day} of ${phase.length}"><span style="width:${Math.min(100, (phase.day / phase.length) * 100)}%"></span></div>` : ''}
      </section>
      <div class="plan-nav">
        <nav class="tabs" aria-label="Plan sections">${tabs}</nav>
        <div class="nav-tools">
          <label class="search">${icon('search')}<input type="search" id="search" placeholder="Search this plan" value="${esc(state.query)}" autocomplete="off" aria-label="Search this plan"><kbd>/</kbd></label>
          <a class="tab ${r.tab === 'history' && !state.query ? 'active' : ''}" href="#/p/${state.plan.id}/history" title="History">${icon('history')}<span class="hide-s">History</span></a>
          ${state.ai ? `<button class="btn primary sm nav-ai" data-action="toggle-chat" title="Open the assistant (a)">${icon('sparkles')}Assistant</button>` : ''}
        </div>
      </div>
      <div id="plan-body">${planBody(r)}</div>
    </main>
    ${state.ai ? `<button class="btn primary chat-fab" data-action="toggle-chat">${icon('sparkles')}Ask or dump</button>${chatPanel()}` : ''}`;
}

export function planBody(r) {
  const { doc } = state.plan;
  if (state.query.trim()) return searchView(doc);
  if (r.tab === 'overview') return overview(doc);
  if (r.tab === 'history') return historyView();
  const tab = doc.tabs.find((t) => t.id === r.tab);
  return tab ? tabView(tab) : `<div class="empty">That tab no longer exists. <a href="#/p/${state.plan.id}">Go to the overview</a></div>`;
}

// ---------- item pieces ----------
function itemFacts(i, { showTab = false } = {}) {
  const facts = [];
  const range = dateRange(i.date, i.endDate);
  const n = nights(i.date, i.endDate);
  if (range) facts.push(`${icon('calendar')}${esc(range)}${n ? ` · ${plural(n, 'night')}` : ''}${i.time ? ` · ${esc(i.time)}` : ''}`);
  else if (i.time) facts.push(`${icon('clock')}${esc(i.time)}`);
  const where = [i.location, i.country].filter(Boolean).join(', ');
  if (where) facts.push(`${icon('pin')}${esc(where)}`);
  if (showTab) facts.push(`<span class="in-tab">${esc(i.tabTitle)}</span>`);
  return facts.length ? `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : '';
}

function priceTrend(i) {
  const first = (i.priceHistory || [])[0];
  if (!i.price || (i.priceHistory || []).length < 2 || first.currency !== i.price.currency || first.amount === i.price.amount) return '';
  const down = i.price.amount < first.amount;
  return `<span class="trend ${down ? 'down' : 'up'}" title="Was ${esc(money(first))}">${down ? '↓' : '↑'} from ${esc(money(first))}</span>`;
}

// "per person" plus any note, without saying "per person" twice.
export const priceNote = (p) => [p.per === 'person' && !/per person/i.test(p.note || '') ? 'per person' : '', p.note].filter(Boolean).join(' · ');

export function priceHtml(i) {
  if (!i.price) return '';
  return `<span class="price-wrap"><span class="price">${esc(money(i.price))}</span>${priceNote(i.price) ? ` <span class="small muted">${esc(priceNote(i.price))}</span>` : ''} ${priceTrend(i)}</span>`;
}

// A status pill. With an item id it is a button that opens the status menu.
export const statusPill = (s, itemId = null) => (itemId
  ? `<button type="button" class="status ${esc(s)}" data-action="status" data-item="${esc(itemId)}" title="Change status">${esc(s)}</button>`
  : `<span class="status ${esc(s)}">${esc(s)}</span>`);
export const linksHtml = (links = []) => (links.length ? `<div class="links">${links.map((l) => `<a class="link-chip" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer" data-stop>${icon('arrow')}<span>${esc(l.label || hostOf(l.url))}</span></a>`).join('')}</div>` : '');
export const tagsHtml = (tags = [], { clickable = true } = {}) => (tags.length ? `<div class="tags">${tags.map((t) => (clickable ? `<button type="button" class="tag" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>` : `<span class="tag">#${esc(t)}</span>`)).join('')}</div>` : '');
export function detailsHtml(d = {}) {
  const e = Object.entries(d);
  return e.length ? `<dl class="kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}

// readonly cards (history snapshots) have no working buttons.
export function card(i, { showTab = false, readonly = false, drag = false } = {}) {
  return `<article class="card k-${esc(i.kind)} ${i.status === 'rejected' ? 'rejected' : ''}" ${readonly ? '' : `data-item="${esc(i.id)}" tabindex="0"`} ${drag ? 'draggable="true"' : ''}>
    ${i.image ? `<img class="card-img" src="${esc(safeUrl(i.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <div class="card-top">
      <div class="kind">${kindIcon(i.kind)}</div>
      <div class="card-title">
        <h3>${esc(i.title)}</h3>
        ${i.subtitle ? `<div class="sub">${esc(i.subtitle)}</div>` : ''}
      </div>
      ${i.pinned ? '<span class="pin" title="Pinned">📌</span>' : ''}
    </div>
    <div class="card-row">${statusPill(i.status, readonly ? null : i.id)}${priceHtml(i)}</div>
    ${itemFacts(i, { showTab })}
    ${detailsHtml(i.details)}
    ${i.description ? `<div class="desc-text">${md(i.description)}</div>` : ''}
    ${linksHtml(i.links)}
    ${tagsHtml(i.tags, { clickable: !readonly })}
  </article>`;
}

// ---------- tab ----------
function filterItems(items) {
  if (state.filter === 'all') return items.filter((i) => i.status !== 'rejected' || items.every((x) => x.status === 'rejected'));
  if (state.filter === 'everything') return items;
  return items.filter((i) => i.status === state.filter);
}

export const sortFor = (tabId) => lsGet('lfg_sort', {})[tabId] || 'manual';

function tabView(tab) {
  const present = new Set(tab.items.map((i) => i.status));
  const hidden = tab.items.filter((i) => i.status === 'rejected').length;
  const chips = [
    ['all', 'Active'], ...STATUSES.filter((s) => present.has(s)).map((s) => [s, cap(s)]), ['everything', 'Everything'],
  ];
  const sort = sortFor(tab.id);
  const items = sortItems(filterItems(tab.items), sort);
  let content;
  if (!tab.items.length) {
    content = `<div class="empty"><div class="big">${esc(tab.emoji || '🗂️')}</div><p><strong>Nothing here yet.</strong></p>
      <p>Type in the box above and press Enter, or add something with all the details.</p>
      <button class="btn primary" data-action="add-item" data-tab="${tab.id}">${icon('plus')}Add something</button></div>`;
  } else if (!items.length) {
    content = '<div class="empty">Nothing matches this filter. <button class="btn sm" data-action="filter" data-filter="everything">Show everything</button></div>';
  } else {
    // Dragging to reorder only makes sense when the tab shows its own order.
    const drag = sort === 'manual';
    content = ({ cards: cardsLayout, table: tableLayout, timeline: timelineLayout, list: listLayout, notes: notesLayout }[tab.layout] || cardsLayout)(items, { drag });
  }
  return `<div class="tab-head">
      <div class="tab-title"><h2>${tab.emoji ? `${esc(tab.emoji)} ` : ''}${esc(tab.title)}</h2>${tab.description ? `<div class="desc">${md(tab.description)}</div>` : ''}</div>
      <div class="tab-tools">
        <select data-action="sort" data-tab="${tab.id}" aria-label="Sort by" class="compact">
          ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${k === 'manual' ? 'Sort' : esc(v)}</option>`).join('')}
        </select>
        <select data-action="layout" data-tab="${tab.id}" aria-label="Layout" class="compact">
          ${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${tab.layout === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <button class="btn sm" data-action="edit-tab" data-tab="${tab.id}">Edit tab</button>
        <button class="btn primary sm" data-action="add-item" data-tab="${tab.id}">${icon('plus')}Add</button>
      </div>
    </div>
    <div class="tab-bar">
      <form class="quick-add" data-form="quick-add" data-tab="${tab.id}">
        ${icon('plus')}<input type="text" id="quick-add" name="title" placeholder="Quick add to ${esc(tab.title)}, then press Enter" autocomplete="off" maxlength="300" aria-label="Quick add">
      </form>
      ${tab.items.length > 1 ? `<div class="filters">${chips.map(([k, l]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-action="filter" data-filter="${k}">${esc(l)}</button>`).join('')}</div>` : ''}
    </div>
    ${content}
    ${state.filter === 'all' && hidden && hidden < tab.items.length ? `<p class="small muted hidden-note">${plural(hidden, 'rejected item')} hidden. <button class="link" data-action="filter" data-filter="everything">Show</button></p>` : ''}`;
}

const cardsLayout = (items, opts) => `<div class="cards">${items.map((i) => card(i, opts)).join('')}</div>`;

function tableLayout(items, { drag = false } = {}) {
  const has = (k) => items.some((i) => i[k] && (!Array.isArray(i[k]) || i[k].length));
  const detailKeys = [...new Set(items.flatMap((i) => Object.keys(i.details || {})))].slice(0, 4);
  const cols = [
    ['Item', (i) => `<div class="cell-item"><span>${kindIcon(i.kind)}</span><div><strong>${esc(i.title)}</strong>${i.pinned ? ' 📌' : ''}${i.subtitle ? `<div class="small muted">${esc(i.subtitle)}</div>` : ''}</div></div>`, 'col-item'],
    has('date') && ['When', (i) => `${esc(shortRange(i.date, i.endDate))}${i.time ? `<div class="small muted">${esc(i.time)}</div>` : ''}`, 'nowrap'],
    (has('location') || has('country')) && ['Where', (i) => esc([i.location, i.country].filter(Boolean).join(', ')), 'col-text'],
    ...detailKeys.map((k) => [k, (i) => esc(i.details?.[k] || ''), 'col-text']),
    has('price') && ['Price', (i) => (i.price ? `<span class="price">${esc(money(i.price))}</span>${priceNote(i.price) ? `<div class="small muted">${esc(priceNote(i.price))}</div>` : ''}${priceTrend(i) ? `<div>${priceTrend(i)}</div>` : ''}` : ''), 'num nowrap'],
    ['Status', (i) => statusPill(i.status, i.id), 'nowrap'],
    has('links') && ['Links', (i) => linksHtml(i.links), 'col-links'],
  ].filter(Boolean);
  return `<div class="table-wrap"><table class="items">
    <thead><tr>${cols.map(([h, , c]) => `<th class="${c || ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${items.map((i) => `<tr data-item="${esc(i.id)}" tabindex="0" ${drag ? 'draggable="true"' : ''} class="${i.status === 'rejected' ? 'rejected' : ''}">${cols.map(([h, f, c]) => { const v = f(i); return `<td class="${c || ''} ${v ? '' : 'blank'}" data-label="${esc(h)}">${v}</td>`; }).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function timelineLayout(items, { showTab = false } = {}) {
  const { doc } = state.plan;
  const dated = sortItems(items.filter((i) => i.date).map((i) => ({ ...i, pinned: false })), 'date');
  const undated = items.filter((i) => !i.date);
  const groups = new Map();
  for (const i of dated) {
    const key = i.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const today = todayStr();
  const row = (i) => {
    const day = tripDay(doc, i.date);
    const n = nights(i.date, i.endDate);
    return `<div class="tl-item k-${esc(i.kind)} ${isFullDate(i.date) && (i.endDate || i.date) < today ? 'past' : ''}" data-item="${esc(i.id)}" tabindex="0">
      <div class="tl-date">${i.date ? esc(i.date.length === 7 ? 'Sometime' : fmtDate(i.date, { short: true })) : ''}${i.endDate ? `<div class="small muted">→ ${esc(fmtDate(i.endDate, { short: true }))}</div>` : ''}${day ? `<div class="day-n">Day ${day}</div>` : ''}</div>
      <div class="tl-body">
        <div class="tl-title"><span>${kindIcon(i.kind)}</span><strong>${esc(i.title)}</strong>${statusPill(i.status, i.id)}${priceHtml(i)}</div>
        ${i.subtitle ? `<div class="small muted">${esc(i.subtitle)}</div>` : ''}
        <div class="small muted">${esc([i.time, n ? plural(n, 'night') : '', i.location, i.country, showTab ? i.tabTitle : ''].filter(Boolean).join(' · '))}</div>
      </div>
    </div>`;
  };
  const section = (title, list) => `<section class="month"><h3>${esc(title)}<span class="small muted">${list.length}</span></h3><div class="tl">${list.map(row).join('')}</div></section>`;
  return `<div class="timeline">
    ${[...groups].map(([k, list]) => section(fmtDate(k), list)).join('')}
    ${undated.length ? section('No date yet', undated) : ''}
  </div>`;
}

function checkRow(i, drag = false) {
  return `<div class="check-row ${i.status === 'done' ? 'done' : ''}" ${drag ? `draggable="true" data-drag-item="${esc(i.id)}"` : ''}>
      <input type="checkbox" data-action="toggle-done" data-item="${esc(i.id)}" ${i.status === 'done' ? 'checked' : ''} aria-label="Mark ${esc(i.title)} as done">
      <div class="body" data-item="${esc(i.id)}" tabindex="0">
        <div class="title"><strong>${esc(i.title)}</strong>${i.date ? ` <span class="small muted">· by ${esc(fmtDate(i.date, { short: true }))}</span>` : ''}${i.price ? ` <span class="small">· ${priceHtml(i)}</span>` : ''}</div>
        ${i.subtitle ? `<div class="small muted">${esc(i.subtitle)}</div>` : ''}
        ${i.description ? `<div class="small muted desc-text">${md(i.description)}</div>` : ''}
        ${linksHtml(i.links)}
      </div>
    </div>`;
}

function listLayout(items, { drag = false } = {}) {
  const done = items.filter((i) => i.status === 'done').length;
  return `${items.length > 1 ? `<div class="progress-line"><div class="bar"><span style="width:${(done / items.length) * 100}%"></span></div><span class="small muted">${done} of ${items.length} done</span></div>` : ''}
    <div class="checklist">${items.map((i) => checkRow(i, drag)).join('')}</div>`;
}

function notesLayout(items, { drag = false } = {}) {
  return `<div class="notes">${items.map((i) => `
    <article class="note" data-item="${esc(i.id)}" tabindex="0" ${drag ? 'draggable="true"' : ''}>
      <h3>${kindIcon(i.kind)} ${esc(i.title)}</h3>
      ${i.subtitle ? `<div class="muted small">${esc(i.subtitle)}</div>` : ''}
      <div class="desc-text">${md(i.description)}</div>
      ${linksHtml(i.links)}
      ${tagsHtml(i.tags)}
    </article>`).join('')}</div>`;
}

// ---------- search ----------
function searchView(doc) {
  const results = sortItems(searchItems(doc, state.query));
  return `<div class="tab-head">
      <div class="tab-title"><h2>Search</h2><div class="desc">${results.length ? `${plural(results.length, 'result')} for “${esc(state.query.trim())}” across every tab.` : `Nothing matches “${esc(state.query.trim())}”.`}</div></div>
      <div class="tab-tools"><button class="btn sm" data-action="clear-search">Clear search</button></div>
    </div>
    ${results.length ? cardsLayout(results, { showTab: true }) : '<div class="empty"><div class="big">🔍</div><p>Try fewer words, a place, a status such as “booked”, or a tag such as “#must-do”.</p></div>'}`;
}

// ---------- overview ----------
const panel = (title, body, cls = '') => `<section class="panel ${cls}"><h3>${title}</h3>${body}</section>`;

// A strip of the whole trip: where you are, where you sleep and travel days,
// with the nights that have no stay yet listed underneath.
function glance(doc) {
  const strip = tripStrip(doc);
  if (!strip) return '';
  const cov = stayCoverage(doc);
  const { lanes, rows } = strip;
  if (!lanes.place.length && !lanes.stay.length && !lanes.travel.length) {
    return panel('Trip at a glance', '<p class="hint-text">Give places and stays a start and end date and they appear here as a picture of the whole trip, with the nights that still need somewhere to sleep.</p>');
  }
  const ROW = 30;
  const colour = (c) => (c ? `c${strip.countries.indexOf(c) % 6}` : 'c-none');
  const firm = (s) => s === 'confirmed' || s === 'booked' || s === 'done';
  const grid = strip.months.map((m) => `<i class="g-line" style="left:${m.left}%"></i>`).join('');
  const today = todayStr();
  const todayAt = today >= doc.start && today <= doc.end ? `<i class="g-today" style="left:${(daysBetween(doc.start, today) / strip.days) * 100}%" title="Today"></i>` : '';
  const bar = (b, lane) => `<button type="button" class="seg ${lane} ${lane === 'travel' ? '' : colour(b.country)} ${firm(b.status) ? '' : 'tentative'}" data-item="${esc(b.id)}"
      style="left:${b.left}%;width:${lane === 'travel' ? 0 : b.width}%;top:${b.row * ROW}px" title="${esc(`${b.title} · ${shortRange(b.date, b.endDate) || fmtDate(b.date)} · ${b.status}`)}">${lane === 'travel' ? '' : `<span>${esc(b.title)}</span>`}</button>`;
  const lane = (key, label) => (lanes[key].length ? `<div class="g-label">${label}</div><div class="g-track" style="height:${rows[key] * ROW - 4}px">${grid}${todayAt}${lanes[key].map((b) => bar(b, key)).join('')}</div>` : '');
  let gaps = '';
  if (cov && !lanes.stay.length) gaps = '<p class="hint-text">No stays with dates yet, so every night is still open.</p>';
  else if (cov && !cov.gaps.length) gaps = '<p class="hint-text">Every night has somewhere to stay. 🎉</p>';
  else if (cov) {
    gaps = `<p class="gaps"><strong>${plural(cov.nights - cov.covered, 'night')} with nowhere to stay yet:</strong> ${cov.gaps.slice(0, 5).map((g) => `<span>${esc(shortRange(g.from, g.to))} <small>${g.nights}n</small></span>`).join('')}${cov.gaps.length > 5 ? `<span>and ${cov.gaps.length - 5} more</span>` : ''}</p>`;
  }
  return panel(`Trip at a glance${strip.countries.length ? `<span class="g-legend">${strip.countries.map((c) => `<span><i class="${colour(c)}"></i>${esc(c)}</span>`).join('')}</span>` : ''}`, `
    <div class="glance-scroll"><div class="glance">
      <div></div><div class="g-track g-months">${strip.months.map((m) => `<span style="left:${m.left}%">${esc(fmtDate(m.key, { short: true }).split(' ')[0])}</span>`).join('')}</div>
      ${lane('place', 'Where')}${lane('stay', 'Stays')}${lane('travel', 'Travel')}
    </div></div>
    ${gaps}`, 'glance-panel');
}

function overview(doc) {
  const items = allItems(doc);
  if (!items.length && !doc.summary) {
    return `<div class="empty"><div class="big">🌍</div>
      <p><strong>A blank page, full of possibility.</strong></p>
      <p>${state.ai ? 'Dump anything into the assistant: flights you\'ve spotted, countries you fancy, things to do. It will sort them into tabs.' : 'Open a tab and start dropping ideas in.'}</p>
      ${state.ai ? `<button class="btn primary" data-action="toggle-chat">${icon('sparkles')}Open the assistant</button>` : ''}</div>`;
  }
  const people = doc.travellers?.length || 1;
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  const live = items.filter((i) => i.status !== 'rejected');
  const booked = byStatus.booked + byStatus.done;
  const deciding = byStatus.considering + byStatus.shortlisted;
  const toBook = byStatus.confirmed;
  const sums = totals(items, people);
  const byKind = spendByKind(items, people);
  const budget = budgetUse(doc, sums);
  const cov = stayCoverage(doc);
  const multiplied = people > 1 && items.some((i) => i.price && isPerPerson(i.price) && ['booked', 'done', 'confirmed', 'shortlisted'].includes(i.status));
  const countries = {};
  for (const i of live) if (i.country) countries[i.country] = (countries[i.country] || 0) + 1;
  const pinned = items.filter((i) => i.pinned);
  const dated = live.filter((i) => i.date && ['booked', 'confirmed', 'shortlisted', 'done'].includes(i.status));
  const todoTabs = new Set(doc.tabs.filter((t) => t.layout === 'list').map((t) => t.id));
  const todos = live.filter((i) => i.kind === 'todo' || todoTabs.has(i.tabId));
  const openTodos = sortItems(todos.filter((i) => i.status !== 'done').map((i) => ({ ...i, pinned: false })), 'date');
  const upcoming = nextUp(doc, todayStr(), 6);
  const since = state.newSince;
  const cash = (amount, currency) => money({ amount, currency });
  const when = (i) => (i.overdue ? `${plural(-i.inDays, 'day')} late` : i.inDays <= 0 ? (i.inDays === 0 ? 'Today' : 'Now') : i.inDays === 1 ? 'Tomorrow' : i.inDays < 60 ? `In ${i.inDays} days` : `In ${Math.round(i.inDays / 7)} weeks`);

  const stat = (n, label, sub = '', extra = '') => `<div class="stat"><div class="n">${n}</div><div class="l">${label}</div>${extra}${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const stats = [
    stat(`${booked}<small> of ${live.length}</small>`, 'Booked', [deciding && `${deciding} still to decide`, toBook && `${toBook} confirmed, to book`].filter(Boolean).join(' · ') || (live.length - booked ? `${plural(live.length - booked, 'idea')} to firm up` : 'Everything is booked')),
    cov
      ? stat(`${cov.covered}<small> of ${cov.nights}</small>`, 'Nights with a stay', cov.booked === cov.covered ? (cov.covered ? 'All of those are booked' : 'Add stays with dates') : `${cov.booked} booked, ${cov.covered - cov.booked} in mind`, `<div class="bar two"><span style="width:${(cov.booked / cov.nights) * 100}%"></span><span class="soft" style="width:${((cov.covered - cov.booked) / cov.nights) * 100}%"></span></div>`)
      : stat(live.length, 'Things in the plan', 'Set the trip dates to see nights covered'),
    budget
      ? stat(`<span class="money-n">${esc(cash(budget.booked, budget.currency))}</span><small> of ${esc(cash(budget.amount, budget.currency))}</small>`, 'Budget booked',
        budget.left >= 0 ? `${esc(cash(budget.left, budget.currency))} left if you book the rest` : `<span class="over">${esc(cash(-budget.left, budget.currency))} over if you book the rest</span>`,
        `<div class="bar two ${budget.left < 0 ? 'over' : ''}"><span style="width:${Math.min(100, (budget.booked / budget.amount) * 100)}%"></span><span class="soft" style="width:${Math.max(0, Math.min(100 - (budget.booked / budget.amount) * 100, (budget.shortlisted / budget.amount) * 100))}%"></span></div>`)
      : stat(`<span class="money-n">${esc(fmtTotals(sums.booked) || '—')}</span>`, 'Spent or booked', 'Set a budget in Edit details to track it'),
    stat(`<span class="money-n">${esc(fmtTotals(sums.shortlisted) || '—')}</span>`, 'Confirmed or shortlisted, not booked', budget && Object.keys(budget.other).length ? `Not in the budget sum: ${esc(fmtTotals(budget.other))}` : ''),
  ].join('');

  const side = [
    upcoming.length ? panel('Next up', `<div class="next-list">${upcoming.map((i) => `
      <button type="button" class="next ${i.overdue ? 'overdue' : ''}" data-item="${esc(i.id)}">
        <span class="kind k-${esc(i.kind)}">${kindIcon(i.kind)}</span>
        <span class="grow"><strong class="clamp-1">${esc(i.title)}</strong><span class="small muted clamp-1">${esc([fmtDate(i.date, { short: true }), i.todo ? 'to do' : i.status, i.location || i.country].filter(Boolean).join(' · '))}</span></span>
        <span class="when">${esc(when(i))}</span>
      </button>`).join('')}</div>`) : '',
    panel('Progress', `
      <div class="status-bar">${STATUSES.filter((s) => byStatus[s]).map((s) => `<span class="${s}" style="width:${(byStatus[s] / items.length) * 100}%" title="${s}: ${byStatus[s]}"></span>`).join('')}</div>
      <div class="legend">${STATUSES.filter((s) => byStatus[s]).map((s) => `<button type="button" data-action="search-for" data-q="${s}"><i class="${s}"></i>${cap(s)} <b>${byStatus[s]}</b></button>`).join('')}</div>`),
    byKind.length ? panel('Money', `
      <table class="money">
        <thead><tr><th></th><th>Booked</th><th>Not booked yet</th></tr></thead>
        <tbody>${byKind.map((k) => `<tr><td>${kindIcon(k.kind)} ${esc(cap(k.kind))}</td><td>${esc(fmtTotals(k.booked) || '—')}</td><td class="muted">${esc(fmtTotals(k.shortlisted) || '—')}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td>${esc(fmtTotals(sums.booked) || '—')}</td><td class="muted">${esc(fmtTotals(sums.shortlisted) || '—')}</td></tr></tfoot>
      </table>
      <p class="hint-text">${multiplied ? `Per-person prices are counted for all ${people} of you.` : people > 1 ? 'Mark a price as “per person” and it is counted for everyone going.' : 'Add who\'s going in Edit details to count per-person prices for everyone.'}</p>`) : '',
    todos.length ? panel(`To do <span class="small muted">${todos.length - openTodos.length} of ${todos.length} done</span>`, `
      <div class="bar"><span style="width:${((todos.length - openTodos.length) / todos.length) * 100}%"></span></div>
      ${openTodos.length ? `<div class="checklist flat">${openTodos.slice(0, 6).map((i) => checkRow(i)).join('')}</div>${openTodos.length > 6 ? `<p class="hint-text">and ${openTodos.length - 6} more</p>` : ''}` : '<p class="hint-text">All done. 🎉</p>'}`) : '',
    Object.keys(countries).length ? panel('Countries', `<div class="country-chips">${Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<button class="country" data-action="search-for" data-q="${esc(c)}">${esc(c)}<small>${n}</small></button>`).join('')}</div>`) : '',
    panel('Tabs', `<div class="tab-list">${doc.tabs.map((t) => `<a href="#/p/${state.plan.id}/t/${t.id}"><span class="kind">${esc(t.emoji || '🗂️')}</span><span class="grow"><strong>${esc(t.title)}</strong>${t.description ? `<span class="small muted clamp-1">${esc(t.description)}</span>` : ''}</span><span class="count">${t.items.length}</span></a>`).join('')}</div>`),
  ].join('');

  return `<div class="overview">
    <div class="ov-main">
      ${since ? `<div class="banner">${icon('history')}<span><strong>${plural(since.to - since.from, 'change')}</strong> since you were last here.</span><a class="btn sm" href="#/p/${state.plan.id}/history">See what changed</a><button class="icon-btn" data-action="dismiss-since" aria-label="Dismiss">${icon('x')}</button></div>` : ''}
      ${doc.summary ? `<div class="panel summary desc-text">${md(doc.summary)}</div>` : ''}
      <div class="ov-grid">${stats}</div>
      ${glance(doc)}
      ${pinned.length ? `<h2 class="section-title">Pinned</h2>${cardsLayout(pinned, { showTab: true })}` : ''}
      ${dated.length ? `<h2 class="section-title">Itinerary so far</h2><p class="small muted section-note">Shortlisted, confirmed and booked things with dates, across every tab.</p>${timelineLayout(dated, { showTab: true })}` : ''}
    </div>
    <aside class="ov-side">${side}</aside>
  </div>`;
}

// ---------- history ----------
function historyView() {
  const h = state.history;
  if (!h) return '';
  const sel = h.selected;
  const seen = state.newSince?.from ?? Infinity;
  const list = `<div class="versions">${h.versions.map((v) => `
      <a class="version ${sel?.n === v.n ? 'selected' : ''}" href="#/p/${state.plan.id}/history/${v.n}">
        <div class="n">v${v.n}</div>
        <div><div>${esc(v.summary)}</div><div class="small muted">${esc(v.author)} · ${esc(ago(v.created_at))}${v.n > seen ? ' · <span class="new">new</span>' : ''}</div></div>
        <span class="src ${esc(v.source)}">${esc(v.source === 'ai' ? 'Assistant' : cap(v.source))}</span>
      </a>`).join('')}</div>
      ${h.versions.length && h.versions[h.versions.length - 1].n > 1 ? '<div class="more-row"><button class="btn" data-action="older-versions">Show older versions</button></div>' : ''}`;
  if (!sel) {
    return `<div class="tab-head"><div class="tab-title"><h2>History</h2><div class="desc">Every change is saved as a version. Pick one to see what changed, preview it, or bring it back.</div></div></div>${list}`;
  }
  return `<div class="tab-head">
      <div class="tab-title"><a class="btn sm ghost back" href="#/p/${state.plan.id}/history">← All versions</a><h2>Version ${sel.n}</h2>
      <div class="desc">${esc(sel.summary)} · ${esc(sel.author)} · ${esc(new Date(sel.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</div></div>
      <div class="tab-tools">${sel.n !== h.current ? `<button class="btn primary sm" data-action="restore" data-version="${sel.n}">Restore this version</button>` : '<span class="small muted">This is the current version</span>'}</div>
    </div>
    <h3 class="section-title first">What changed</h3>
    <div class="panel diff">${diffDocs(sel.previous, sel.doc).join('')}</div>
    <h3 class="section-title">How the plan looked</h3>
    <div class="banner">Read-only snapshot of v${sel.n}: “${esc(sel.doc.title)}”, ${plural(sel.doc.tabs.length, 'tab')}, ${plural(allItems(sel.doc).length, 'item')}.</div>
    ${sel.doc.tabs.map((t) => `<h3 class="section-title">${esc(t.emoji)} ${esc(t.title)}</h3>${t.items.length ? `<div class="cards snapshot">${t.items.map((i) => card(i, { readonly: true })).join('')}</div>` : '<div class="muted small">Empty</div>'}`).join('')}`;
}

// ---------- chat ----------
const HINTS = [
  'Here\'s a brain dump, please sort it into tabs: …',
  'Flight LHR → BKK on 3 March, £612 return each, link: …',
  'The Tokyo flight is now £540, update it',
  'Tidy up the Inbox and suggest a rough route',
];

export function chatLog() {
  const msgs = state.chat.map((m) => (m.role === 'user'
    ? `<div class="msg user"><div class="who">${esc(m.author)}</div>${esc(m.text)}</div>`
    : `<div class="msg assistant">${md(m.text)}${m.version ? `<div class="small msg-foot"><a href="#/p/${state.plan.id}/history/${m.version}">See changes (v${m.version})</a></div>` : ''}</div>`)).join('');
  const working = state.thinking ? `<div class="msg assistant thinking" aria-live="polite">
      <div>Working on it<span class="dot-pulse"></span></div>
      ${state.steps.length ? `<ul class="steps">${state.steps.slice(-6).map((s) => `<li>${icon('check')}${esc(s)}</li>`).join('')}</ul>` : ''}
    </div>` : '';
  return `${msgs || `<div class="muted small">Tell me anything about this trip and I'll file it in the right place, make new tabs when needed, update prices, or answer questions about the plan.</div>
        <div class="chat-hints">${HINTS.map((h) => `<button class="hint" data-action="hint">${esc(h)}</button>`).join('')}</div>`}${working}`;
}

function chatPanel() {
  return `<div class="chat-back ${state.chatOpen ? 'open' : ''}"><aside class="chat" role="dialog" aria-modal="true" aria-label="Assistant">
    <div class="chat-head">${icon('sparkles')}<h3>Assistant</h3><span class="small muted clamp-1">${esc(state.plan.doc.title)}</span><button class="icon-btn chat-close" data-action="toggle-chat" title="Close" aria-label="Close">${icon('x')}</button></div>
    <div class="chat-log">${chatLog()}</div>
    <form class="chat-form" id="chat-form">
      <textarea name="message" placeholder="Dump ideas, paste links, ask for changes…" ${state.thinking ? 'disabled' : ''} aria-label="Message">${esc(state.draft || '')}</textarea>
      <div class="row"><span class="small muted">⌘/Ctrl + Enter to send</span><button class="btn primary sm" ${state.thinking ? 'disabled' : ''}>Send</button></div>
    </form>
  </aside></div>`;
}
