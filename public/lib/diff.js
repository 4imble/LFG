// Describes what changed between two versions of a plan, as HTML lines.

import { esc, money } from './format.js';
import { allItems } from './plan.js';

const code = (v) => `<code>${esc(v || '—')}</code>`;
const ITEM_TEXT_FIELDS = { subtitle: 'subtitle', description: 'notes', date: 'start date', endDate: 'end date', time: 'time', location: 'location', country: 'country', kind: 'kind', image: 'image' };

export function diffDocs(prev, next) {
  if (!prev) return ['<div class="add">Plan created</div>'];
  const out = [];
  for (const k of ['title', 'subtitle', 'emoji', 'start', 'end', 'summary']) {
    if ((prev[k] || '') !== (next[k] || '')) out.push(`<div class="chg">✎ Plan ${esc(k)} changed${k !== 'summary' ? `: ${code(prev[k])} → ${code(next[k])}` : ''}</div>`);
  }
  if ((prev.cover || '') !== (next.cover || '')) out.push(`<div class="chg">✎ Cover photo ${next.cover ? (prev.cover ? 'changed' : 'added') : 'removed'}</div>`);
  if (JSON.stringify(prev.budget || null) !== JSON.stringify(next.budget || null)) out.push(`<div class="chg">✎ Budget: ${code(money(prev.budget))} → ${code(money(next.budget))}</div>`);
  if ((prev.travellers || []).join('|') !== (next.travellers || []).join('|')) out.push(`<div class="chg">✎ Travellers: ${code((prev.travellers || []).join(', '))} → ${code((next.travellers || []).join(', '))}</div>`);
  const pt = new Map(prev.tabs.map((t) => [t.id, t]));
  const nt = new Map(next.tabs.map((t) => [t.id, t]));
  for (const t of next.tabs) {
    const o = pt.get(t.id);
    if (!o) { out.push(`<div class="add">＋ New tab <strong>${esc(t.emoji)} ${esc(t.title)}</strong></div>`); continue; }
    if (o.title !== t.title) out.push(`<div class="chg">✎ Tab renamed ${code(o.title)} → ${code(t.title)}</div>`);
    if (o.layout !== t.layout) out.push(`<div class="chg">✎ ${esc(t.title)} layout → ${esc(t.layout)}</div>`);
  }
  for (const t of prev.tabs) if (!nt.has(t.id)) out.push(`<div class="del">－ Removed tab <strong>${esc(t.title)}</strong></div>`);
  const shared = prev.tabs.map((t) => t.id).filter((id) => nt.has(id));
  if (shared.join() !== next.tabs.map((t) => t.id).filter((id) => pt.has(id)).join()) out.push('<div class="chg">✎ Tabs reordered</div>');

  const pi = new Map(allItems(prev).map((i) => [i.id, i]));
  const ni = new Map(allItems(next).map((i) => [i.id, i]));
  for (const [id, i] of ni) {
    const o = pi.get(id);
    if (!o) { out.push(`<div class="add">＋ Added <strong>${esc(i.title)}</strong> <span class="muted">in ${esc(i.tabTitle)}</span></div>`); continue; }
    const changes = [];
    if (o.title !== i.title) changes.push(`renamed from ${code(o.title)}`);
    if (o.tabId !== i.tabId) changes.push(`moved to ${esc(i.tabTitle)}`);
    if (o.status !== i.status) changes.push(`status ${code(o.status)} → ${code(i.status)}`);
    if (JSON.stringify(o.price) !== JSON.stringify(i.price)) changes.push(`price ${code(money(o.price))} → ${code(money(i.price))}`);
    if (Boolean(o.pinned) !== Boolean(i.pinned)) changes.push(i.pinned ? 'pinned' : 'unpinned');
    for (const [k, label] of Object.entries(ITEM_TEXT_FIELDS)) if ((o[k] ?? '') !== (i[k] ?? '')) changes.push(label);
    for (const k of ['links', 'tags', 'details']) if (JSON.stringify(o[k]) !== JSON.stringify(i[k])) changes.push(k);
    if (changes.length) out.push(`<div class="chg">✎ <strong>${esc(i.title)}</strong>: ${changes.join(', ')}</div>`);
  }
  for (const [id, i] of pi) if (!ni.has(id)) out.push(`<div class="del">－ Removed <strong>${esc(i.title)}</strong> <span class="muted">from ${esc(i.tabTitle)}</span></div>`);
  return out.length ? out : ['<div class="muted">No visible changes</div>'];
}
