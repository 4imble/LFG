// Dialogs: viewing and editing items, tabs and plans, plus a few small prompts.

import { esc, safeUrl, md, money, plural, ago } from './lib/format.js';
import { allItems } from './lib/plan.js';
import { state, KINDS, STATUSES, LAYOUTS, icon, name, setName, toast, api, saveOps, undoToast, findItem, go, rerender, hooks, openModal, closeModal } from './core.js';
import { statusPill, priceHtml, linksHtml, tagsHtml, detailsHtml } from './views.js';

const closeBtn = `<button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>`;
// A destructive button that needs a second click.
function confirmClick(e, label = 'Really delete?') {
  const b = e.currentTarget;
  if (b.dataset.sure === '1') return true;
  b.dataset.sure = '1';
  b.textContent = label;
  return false;
}
const mapsUrl = (i) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([i.location, i.country].filter(Boolean).join(', '))}`;

// ---------- item ----------
export function itemDetail(id) {
  const found = findItem(id);
  if (!found) return;
  const { item: i, tab } = found;
  const hist = i.priceHistory || [];
  const where = [i.location, i.country].filter(Boolean).join(', ');
  const range = [i.date, i.endDate].filter(Boolean).length;
  openModal(`
    <div class="modal-head"><div class="kind k-${esc(i.kind)}">${KINDS[i.kind] || '✨'}</div><div class="grow"><h2>${esc(i.title)}</h2>${i.subtitle ? `<div class="muted">${esc(i.subtitle)}</div>` : ''}</div>${closeBtn}</div>
    <div class="modal-body">
      <div class="card-row">${statusPill(i.status, i.id)}${priceHtml(i)}<span class="small muted">in ${esc(tab.title)}</span></div>
      ${i.image ? `<img class="detail-img" src="${esc(safeUrl(i.image))}" alt="" referrerpolicy="no-referrer">` : ''}
      ${range || i.time || where ? `<dl class="kv">
        ${range ? `<dt>When</dt><dd>${esc([i.date, i.endDate].filter(Boolean).map((d) => new Date(`${d.length === 7 ? `${d}-01` : d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: d.length === 10 ? 'short' : undefined, day: d.length === 10 ? 'numeric' : undefined, month: 'short', year: 'numeric', timeZone: 'UTC' })).join(' → '))}</dd>` : ''}
        ${i.time ? `<dt>Time</dt><dd>${esc(i.time)}</dd>` : ''}
        ${where ? `<dt>Where</dt><dd>${esc(where)} · <a href="${esc(mapsUrl(i))}" target="_blank" rel="noopener noreferrer">Open in Maps</a></dd>` : ''}
      </dl>` : ''}
      ${detailsHtml(i.details)}
      ${i.description ? `<div class="desc-text">${md(i.description)}</div>` : ''}
      ${linksHtml(i.links)}
      ${tagsHtml(i.tags, { clickable: false })}
      ${hist.length > 1 ? `<div><strong class="small">Price history</strong><div class="price-hist">${hist.map((p) => `<div><span>${esc(new Date(p.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</span><span>${esc(money(p))}${p.note ? ` <span class="muted">${esc(p.note)}</span>` : ''}</span></div>`).join('')}</div></div>` : ''}
      <div class="by">${i.addedBy ? `Added by ${esc(i.addedBy)} · ` : ''}updated ${esc(ago(i.updatedAt))}</div>
    </div>
    <div class="modal-foot">
      <div class="left"><button class="btn danger sm" data-act="delete">Delete</button></div>
      ${state.plan.doc.tabs.length > 1 ? `<select data-act="move" class="compact" aria-label="Move to another tab">${state.plan.doc.tabs.map((t) => `<option value="${t.id}" ${t.id === tab.id ? 'selected' : ''}>${t.id === tab.id ? `In ${esc(t.title)}` : `Move to ${esc(t.title)}`}</option>`).join('')}</select>` : ''}
      <button class="btn sm" data-act="duplicate">Duplicate</button>
      <button class="btn sm" data-act="pin">${i.pinned ? 'Unpin' : '📌 Pin'}</button>
      <button class="btn primary" data-act="edit" autofocus>${icon('edit')}Edit</button>
    </div>`, (m) => {
    const on = (act, event, fn) => m.querySelector(`[data-act=${act}]`)?.addEventListener(event, (e) => fn(e).catch(() => {}));
    m.querySelector('[data-act=edit]').onclick = () => itemEditor({ item: i, tabId: tab.id });
    on('pin', 'click', async () => { await saveOps([{ type: 'update_item', item_id: i.id, changes: { pinned: !i.pinned } }]); closeModal(); rerender(); });
    on('duplicate', 'click', async () => {
      const { id: _id, priceHistory: _h, addedBy: _a, createdAt: _c, updatedAt: _u, pinned: _p, ...copy } = i;
      const res = await saveOps([{ type: 'add_item', tab_id: tab.id, item: { ...copy, title: `${i.title} (copy)`.slice(0, 300) } }]);
      closeModal(); rerender();
      itemEditor({ item: findItem(res.results[0].id).item, tabId: tab.id });
    });
    on('move', 'change', async (e) => {
      const dest = state.plan.doc.tabs.find((t) => t.id === e.target.value);
      const res = await saveOps([{ type: 'move_item', item_id: i.id, to_tab_id: dest.id }]);
      closeModal(); rerender(); undoToast(`Moved to ${dest.title}`, res.version);
    });
    on('delete', 'click', async (e) => {
      if (!confirmClick(e)) return;
      const res = await saveOps([{ type: 'delete_item', item_id: i.id }]);
      closeModal(); rerender(); undoToast(`Deleted “${i.title}”`, res.version);
    });
  });
}

// The currency used most in this plan, so new prices default to it.
function usualCurrency() {
  const counts = {};
  for (const i of allItems(state.plan.doc)) if (i.price) counts[i.price.currency] = (counts[i.price.currency] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'GBP';
}

export function itemEditor({ item = null, tabId, preset = {} }) {
  const i = item || { kind: 'idea', status: 'idea', links: [], details: {}, tags: [], ...preset };
  const items = allItems(state.plan.doc);
  const options = (values) => [...new Set(values.filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join('');
  const linkRow = (l = {}) => `<div class="link-row"><input type="text" name="link_label" placeholder="Label" value="${esc(l.label)}" aria-label="Link label"><input type="url" name="link_url" placeholder="https://…" value="${esc(l.url)}" aria-label="Link address"><button type="button" class="icon-btn" data-remove aria-label="Remove link">${icon('x')}</button></div>`;
  const detailRow = ([k, v] = ['', '']) => `<div class="detail-row"><input type="text" name="d_key" placeholder="e.g. Baggage" value="${esc(k)}" aria-label="Detail name"><input type="text" name="d_val" placeholder="e.g. 23kg" value="${esc(v)}" aria-label="Detail value"><button type="button" class="icon-btn" data-remove aria-label="Remove detail">${icon('x')}</button></div>`;
  const hasExtras = Object.keys(i.details || {}).length || i.tags?.length || i.image;
  openModal(`
    <form id="item-form" novalidate>
      <div class="modal-head"><h2>${item ? 'Edit item' : 'Add item'}</h2>${closeBtn}</div>
      <div class="modal-body">
        <label class="field">Title <input type="text" name="title" required maxlength="300" value="${esc(i.title)}" placeholder="e.g. Kyoto, or LHR → HND"></label>
        <div class="grid-2">
          <label class="field">Kind <select name="kind">${Object.entries(KINDS).map(([k, e]) => `<option value="${k}" ${i.kind === k ? 'selected' : ''}>${e} ${k}</option>`).join('')}</select></label>
          <label class="field">Status <select name="status">${STATUSES.map((s) => `<option ${i.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        </div>
        <label class="field">Subtitle <input type="text" name="subtitle" maxlength="300" value="${esc(i.subtitle)}" placeholder="Short extra line"></label>
        <div class="grid-3">
          <label class="field">From <input type="date" name="date" value="${esc(i.date?.length === 10 ? i.date : '')}"></label>
          <label class="field">To <input type="date" name="endDate" value="${esc(i.endDate?.length === 10 ? i.endDate : '')}"></label>
          <label class="field">Time <input type="text" name="time" maxlength="300" value="${esc(i.time)}" placeholder="09:40 → 17:15"></label>
        </div>
        ${[i.date, i.endDate].some((d) => d?.length === 7) ? '<div class="hint-text">This item only has a month so far. Leave the dates empty to keep it that way.</div>' : ''}
        <div class="grid-2">
          <label class="field">Location <input type="text" name="location" maxlength="300" value="${esc(i.location)}" list="dl-locations"></label>
          <label class="field">Country <input type="text" name="country" maxlength="300" value="${esc(i.country)}" list="dl-countries"></label>
        </div>
        <div class="grid-3">
          <label class="field">Price <input type="number" step="0.01" min="0" inputmode="decimal" name="price" value="${esc(i.price?.amount ?? '')}"></label>
          <label class="field">Currency <input type="text" name="currency" value="${esc(i.price?.currency || usualCurrency())}" maxlength="3" list="dl-currencies" class="upper"></label>
          <label class="field">Price note <input type="text" name="price_note" maxlength="200" value="${esc(i.price?.note)}" placeholder="per person"></label>
        </div>
        <label class="field">Notes <textarea name="description" maxlength="8000" placeholder="Anything. **bold** and - bullets work.">${esc(i.description)}</textarea></label>
        <div class="field">Links <div id="links" class="rows">${(i.links?.length ? i.links : [{}]).map(linkRow).join('')}</div><button type="button" class="btn sm start" data-add="links">${icon('plus')}Link</button></div>
        <details class="more" ${hasExtras ? 'open' : ''}>
          <summary>Extra details, tags and image</summary>
          <div class="field">Other details <div id="details" class="rows">${(Object.entries(i.details || {}).length ? Object.entries(i.details) : [['', '']]).map(detailRow).join('')}</div><button type="button" class="btn sm start" data-add="details">${icon('plus')}Detail</button></div>
          <label class="field">Tags <input type="text" name="tags" value="${esc((i.tags || []).join(', '))}" placeholder="beach, must-do"></label>
          <label class="field">Image address <input type="url" name="image" value="${esc(i.image)}" placeholder="https://…"></label>
        </details>
        <div class="error" id="item-error" role="alert"></div>
        <datalist id="dl-locations">${options(items.map((x) => x.location))}</datalist>
        <datalist id="dl-countries">${options(items.map((x) => x.country))}</datalist>
        <datalist id="dl-currencies">${options(['GBP', 'EUR', 'USD', ...items.map((x) => x.price?.currency)])}</datalist>
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close="force">Cancel</button><button class="btn primary">Save</button></div>
    </form>`, (m) => {
    m.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (remove) remove.parentElement.remove();
      const add = e.target.closest('[data-add]')?.dataset.add;
      if (add) {
        m.querySelector(`#${add}`).insertAdjacentHTML('beforeend', add === 'links' ? linkRow() : detailRow());
        m.querySelector(`#${add}`).lastElementChild.querySelector('input').focus();
      }
    });
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const fail = (msg, field) => { m.querySelector('#item-error').textContent = msg; e.target.elements[field]?.focus(); };
      if (!String(f.get('title')).trim()) return fail('Give it a title first.', 'title');
      if (f.get('date') && f.get('endDate') && f.get('endDate') < f.get('date')) return fail('The end date is before the start date.', 'endDate');
      const labels = f.getAll('link_label');
      const links = f.getAll('link_url').map((url, n) => ({ url: url.trim(), label: labels[n].trim() })).filter((l) => l.url)
        .map((l) => ({ ...l, url: /^https?:\/\//i.test(l.url) ? l.url : `https://${l.url}` }));
      const vals = f.getAll('d_val');
      const details = Object.fromEntries(f.getAll('d_key').map((k, n) => [k.trim(), vals[n].trim()]).filter(([k, v]) => k && v));
      const priceStr = String(f.get('price')).trim();
      const keepMonth = (field) => f.get(field) || (i[field]?.length === 7 ? i[field] : '');
      const changes = {
        title: f.get('title').trim(), kind: f.get('kind'), status: f.get('status'), subtitle: f.get('subtitle'),
        date: keepMonth('date'), endDate: keepMonth('endDate'), time: f.get('time'), location: f.get('location').trim(), country: f.get('country').trim(),
        price: priceStr ? { amount: Number(priceStr), currency: String(f.get('currency') || 'GBP').toUpperCase(), note: f.get('price_note') } : null,
        description: f.get('description'), links, details,
        tags: String(f.get('tags')).split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean), image: f.get('image'),
      };
      try {
        await saveOps([item ? { type: 'update_item', item_id: item.id, changes } : { type: 'add_item', tab_id: tabId, item: changes }]);
        closeModal(); rerender(); toast(item ? 'Saved' : 'Added');
      } catch { /* toast shown */ }
    };
  }, { guard: true });
}

// ---------- tab ----------
export function tabEditor(tab = null) {
  const others = state.plan.doc.tabs.filter((t) => t !== tab);
  openModal(`
    <form>
      <div class="modal-head"><h2>${tab ? 'Edit tab' : 'New tab'}</h2>${closeBtn}</div>
      <div class="modal-body">
        <div class="grid-emoji">
          <label class="field">Emoji <input type="text" name="emoji" value="${esc(tab?.emoji ?? '🗂️')}" maxlength="8"></label>
          <label class="field">Name <input type="text" name="title" required maxlength="80" value="${esc(tab?.title)}" autofocus></label>
        </div>
        <label class="field">Layout <select name="layout">${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${tab?.layout === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="hint-text">Cards for browsing, Table for comparing, Timeline for dates, Checklist for to-dos, Notes for longer writing.</span></label>
        <label class="field">Description <textarea name="description" class="short" maxlength="1000">${esc(tab?.description)}</textarea></label>
        ${tab && others.length ? `<div class="field">Position <div class="row-gap"><button type="button" class="btn sm" data-move="-1">← Earlier</button><button type="button" class="btn sm" data-move="1">Later →</button></div></div>
        <div class="field danger-zone">Delete this tab
          <div class="row-gap wrap">${tab.items.length ? `<select name="move_to" class="grow">${others.map((t) => `<option value="${t.id}">Move its ${plural(tab.items.length, 'item')} to ${esc(t.title)}</option>`).join('')}</select>` : ''}
          <button type="button" class="btn danger sm" data-del>Delete tab</button></div></div>` : ''}
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close="force">Cancel</button><button class="btn primary">Save</button></div>
    </form>`, (m) => {
    const form = m.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const fields = { title: f.title, emoji: f.emoji, layout: f.layout, description: f.description };
      try {
        const res = await saveOps([tab ? { type: 'update_tab', tab_id: tab.id, ...fields } : { type: 'add_tab', ...fields }]);
        closeModal();
        if (!tab) go(`#/p/${state.plan.id}/t/${res.results[0].id}`); else rerender();
      } catch { /* toast shown */ }
    };
    m.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      if (!confirmClick(e)) return;
      const moveTo = form.elements.move_to?.value;
      try {
        const res = await saveOps([{ type: 'delete_tab', tab_id: tab.id, ...(moveTo ? { move_items_to_tab_id: moveTo } : {}) }]);
        closeModal(); go(`#/p/${state.plan.id}`); undoToast(`Deleted the ${tab.title} tab`, res.version);
      } catch { /* toast shown */ }
    });
    m.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
      const ids = state.plan.doc.tabs.map((t) => t.id);
      const idx = ids.indexOf(tab.id);
      const to = idx + Number(b.dataset.move);
      if (to < 0 || to >= ids.length) return;
      [ids[idx], ids[to]] = [ids[to], ids[idx]];
      try { await saveOps([{ type: 'reorder_tabs', tab_ids: ids }]); rerender(); } catch { /* toast shown */ }
    }));
  }, { guard: true });
}

// ---------- plan ----------
export function planEditor() {
  const d = state.plan.doc;
  const { hasPassword } = state.plan;
  openModal(`
    <form>
      <div class="modal-head"><h2>Plan details</h2>${closeBtn}</div>
      <div class="modal-body">
        <div class="grid-emoji">
          <label class="field">Emoji <input type="text" name="emoji" value="${esc(d.emoji)}" maxlength="8"></label>
          <label class="field">Name <input type="text" name="title" required maxlength="200" value="${esc(d.title)}"></label>
        </div>
        <label class="field">Tagline <input type="text" name="subtitle" maxlength="200" value="${esc(d.subtitle)}" placeholder="3 months, 6 countries, no alarms"></label>
        <div class="grid-2">
          <label class="field">Starts <input type="date" name="start" value="${esc(d.start)}"></label>
          <label class="field">Ends <input type="date" name="end" value="${esc(d.end)}"></label>
        </div>
        <label class="field">Who's going (comma separated) <input type="text" name="travellers" value="${esc((d.travellers || []).join(', '))}"></label>
        <label class="field">Summary <textarea name="summary" maxlength="8000" placeholder="The big picture">${esc(d.summary)}</textarea></label>
        <div class="error" id="plan-error" role="alert"></div>
        ${state.admin ? `<div class="field danger-zone">${icon('lock')} Plan password
          <div class="hint-text">${hasPassword ? 'This plan has its own password. Share the link and that password to give someone access to this plan only.' : 'No plan password yet, so only the admin password opens this plan. Set one to share it.'}</div>
          <div class="row-gap"><input type="text" id="plan-password" placeholder="${hasPassword ? 'New password' : 'Choose a password'}" autocomplete="off" class="grow" aria-label="Plan password">
          <button type="button" class="btn sm" data-set-password>${hasPassword ? 'Change' : 'Set'}</button>
          ${hasPassword ? '<button type="button" class="btn sm danger" data-clear-password>Remove</button>' : ''}</div>
          <div class="hint-text">Changing or removing it signs out everyone who used the old one.</div></div>` : ''}
      </div>
      <div class="modal-foot">
        <div class="left">${state.admin ? `<button type="button" class="btn sm" data-archive>${state.plan.archived ? 'Unarchive' : 'Archive plan'}</button>` : ''}</div>
        <button type="button" class="btn" data-close="force">Cancel</button><button class="btn primary">Save</button>
      </div>
    </form>`, (m) => {
    const form = m.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { title, emoji, subtitle, start, end, summary, travellers } = Object.fromEntries(new FormData(form));
      if (start && end && end < start) { m.querySelector('#plan-error').textContent = 'The end date is before the start date.'; return; }
      try {
        await saveOps([{ type: 'set_plan_details', title, emoji, subtitle, start, end, summary, travellers: travellers.split(',').map((t) => t.trim()).filter(Boolean) }]);
        closeModal(); rerender();
      } catch { /* toast shown */ }
    };
    const setPw = async (password) => {
      try {
        const r = await api(`/plans/${state.plan.id}/password`, { body: { password } });
        state.plan.hasPassword = r.hasPassword;
        toast(r.hasPassword ? 'Plan password saved' : 'Plan password removed');
        closeModal(); planEditor();
      } catch (err) { toast(`⚠️ ${err.message}`); }
    };
    m.querySelector('[data-set-password]')?.addEventListener('click', () => {
      const input = m.querySelector('#plan-password');
      if (!input.value) { input.focus(); return toast('Type a password first'); }
      return setPw(input.value);
    });
    m.querySelector('[data-clear-password]')?.addEventListener('click', (e) => { if (confirmClick(e, 'Really remove?')) setPw(''); });
    m.querySelector('[data-archive]')?.addEventListener('click', async () => {
      try {
        await api(`/plans/${state.plan.id}/archive`, { body: { archived: !state.plan.archived } });
        state.plan = null;
        closeModal(); go('#/');
      } catch (err) { toast(`⚠️ ${err.message}`); }
    });
  }, { guard: true });
}

export function newPlanModal() {
  openModal(`
    <form>
      <div class="modal-head"><h2>New plan</h2>${closeBtn}</div>
      <div class="modal-body">
        <div class="grid-emoji">
          <label class="field">Emoji <input type="text" name="emoji" value="🌏" maxlength="8"></label>
          <label class="field">Name <input type="text" name="name" required maxlength="100" placeholder="Sabbatical 2027" autofocus></label>
        </div>
        <p class="hint-text">A new plan has no password, so only you can open it until you set one.</p>
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close="force">Cancel</button><button class="btn primary">Create</button></div>
    </form>`, (m) => {
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const plan = await api('/plans', { body: Object.fromEntries(new FormData(e.target)) });
        closeModal(); go(`#/p/${plan.id}`);
      } catch (err) { toast(`⚠️ ${err.message}`); }
    };
  });
}

export function deletePlanModal(plan) {
  openModal(`
    <form>
      <div class="modal-head"><h2>Delete “${esc(plan.title)}”?</h2>${closeBtn}</div>
      <div class="modal-body">
        <p>This permanently deletes the plan, its ${plural(plan.itemCount, 'item')}, its whole history and its assistant chat. It can't be undone. If you might want it later, archive it instead.</p>
        <label class="field">Type the plan's name to confirm <input type="text" name="confirm" autocomplete="off" placeholder="${esc(plan.title)}" autofocus></label>
        <div class="error" id="delete-error" role="alert"></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-close="force">Cancel</button><button class="btn danger solid">Delete for ever</button></div>
    </form>`, (m) => {
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/plans/${plan.id}`, { method: 'DELETE', body: { confirm: new FormData(e.target).get('confirm') } });
        if (state.plan?.id === plan.id) state.plan = null;
        closeModal(); toast('Plan deleted'); hooks.render();
      } catch (err) { m.querySelector('#delete-error').textContent = err.message; }
    };
  });
}

// ---------- small prompts ----------
export function nameModal({ first = false } = {}) {
  openModal(`
    <form>
      <div class="modal-head"><h2>${first ? 'What should we call you?' : 'Your name'}</h2>${first ? '' : closeBtn}</div>
      <div class="modal-body">
        <label class="field">Name <input type="text" name="name" value="${esc(name())}" maxlength="40" required autofocus autocomplete="nickname"></label>
        <p class="hint-text">It's shown next to things you add or change, so everyone can tell who did what.</p>
      </div>
      <div class="modal-foot">${first ? '<button type="button" class="btn" data-close="force">Skip</button>' : '<button type="button" class="btn" data-close="force">Cancel</button>'}<button class="btn primary">Save</button></div>
    </form>`, (m) => {
    m.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      setName(String(new FormData(e.target).get('name')).trim());
      closeModal(); rerender();
    };
  });
}

// Shown when the browser won't let us write to the clipboard.
export function copyModal(title, text) {
  openModal(`
    <div class="modal-head"><h2>${esc(title)}</h2>${closeBtn}</div>
    <div class="modal-body"><input type="text" readonly value="${esc(text)}" autofocus aria-label="${esc(title)}"><p class="hint-text">Select it and copy.</p></div>
    <div class="modal-foot"><button type="button" class="btn primary" data-close="force">Done</button></div>`, (m) => m.querySelector('input').select());
}
