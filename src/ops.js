// Plan document model and the operations that change it.
// Both the UI and the AI assistant edit plans only through applyOp(), so every
// change is validated the same way and can be recorded in version history.

import { randomUUID } from 'node:crypto';

export const ITEM_KINDS = [
  'flight', 'transport', 'stay', 'place', 'activity', 'food', 'event',
  'idea', 'note', 'todo', 'cost', 'document', 'contact', 'other',
];
export const STATUSES = ['idea', 'considering', 'shortlisted', 'booked', 'done', 'rejected'];
export const LAYOUTS = ['cards', 'table', 'timeline', 'list', 'notes'];

const ITEM_FIELDS = [
  'kind', 'title', 'subtitle', 'description', 'status', 'date', 'endDate', 'time',
  'location', 'country', 'price', 'links', 'tags', 'details', 'pinned', 'image',
];

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function emptyPlan({ name = 'New plan', emoji = '🧭' } = {}) {
  return {
    title: name,
    emoji,
    subtitle: '',
    summary: '',
    start: '',
    end: '',
    travellers: [],
    tabs: [
      {
        id: newId('tab'),
        title: 'Inbox',
        emoji: '📥',
        layout: 'cards',
        description: 'Unsorted ideas. Ask the assistant to organise these into tabs.',
        items: [],
      },
    ],
  };
}

export class OpError extends Error {}

const str = (v, max = 4000) => (v == null ? '' : String(v).slice(0, max));
const isDate = (v) => v === '' || /^\d{4}-\d{2}(-\d{2})?$/.test(v);

function cleanPrice(p) {
  if (p == null || p === '') return null;
  if (typeof p === 'number') return { amount: p, currency: 'GBP', note: '' };
  if (typeof p !== 'object') throw new OpError('price must be an object {amount, currency}');
  const amount = Number(p.amount);
  if (!Number.isFinite(amount)) throw new OpError('price.amount must be a number');
  return {
    amount,
    currency: str(p.currency || 'GBP', 8).toUpperCase(),
    note: str(p.note, 200),
  };
}

function cleanLinks(links) {
  if (!Array.isArray(links)) return [];
  return links
    .map((l) => (typeof l === 'string' ? { url: l, label: '' } : l))
    .filter((l) => l && /^https?:\/\//i.test(String(l.url || '')))
    .slice(0, 20)
    .map((l) => ({ url: str(l.url, 2000), label: str(l.label, 120) }));
}

function cleanDetails(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const out = {};
  for (const [k, v] of Object.entries(d).slice(0, 30)) {
    if (v == null || v === '') continue;
    out[str(k, 60)] = str(v, 500);
  }
  return out;
}

// Normalises a partial item. `base` is the existing item when updating.
function cleanItem(input, base = null) {
  const out = base ? structuredClone(base) : {
    id: newId('item'), kind: 'note', title: '', subtitle: '', description: '', status: 'idea',
    date: '', endDate: '', time: '', location: '', country: '', price: null, priceHistory: [],
    links: [], tags: [], details: {}, pinned: false, image: '',
  };
  for (const key of ITEM_FIELDS) {
    if (!(key in input)) continue;
    const v = input[key];
    switch (key) {
      case 'kind': out.kind = ITEM_KINDS.includes(v) ? v : 'other'; break;
      case 'status':
        if (!STATUSES.includes(v)) throw new OpError(`status must be one of ${STATUSES.join(', ')}`);
        out.status = v; break;
      case 'date': case 'endDate':
        if (!isDate(str(v))) throw new OpError(`${key} must be YYYY-MM-DD or YYYY-MM`);
        out[key] = str(v); break;
      case 'price': {
        const next = cleanPrice(v);
        const prev = out.price;
        const changed = JSON.stringify(prev) !== JSON.stringify(next);
        if (changed && next) {
          out.priceHistory = [...(out.priceHistory || []), { ...next, at: new Date().toISOString() }].slice(-50);
        }
        out.price = next; break;
      }
      case 'links': out.links = cleanLinks(v); break;
      case 'tags': out.tags = Array.isArray(v) ? v.map((t) => str(t, 40)).filter(Boolean).slice(0, 20) : []; break;
      case 'details': out.details = cleanDetails(v); break;
      case 'pinned': out.pinned = Boolean(v); break;
      case 'description': out.description = str(v, 8000); break;
      case 'image': out.image = /^https?:\/\//i.test(str(v)) ? str(v, 2000) : ''; break;
      default: out[key] = str(v, 300);
    }
  }
  if (!out.title) throw new OpError('item needs a title');
  out.updatedAt = new Date().toISOString();
  return out;
}

function idExists(doc, id) {
  return doc.tabs.some((t) => t.id === id || t.items.some((i) => i.id === id));
}

// Lets a replayed operation keep the id it was first given.
function pinnedId(doc, requested, prefix) {
  const ok = typeof requested === 'string' && new RegExp(`^${prefix}_[a-z0-9]{10}$`).test(requested);
  return ok && !idExists(doc, requested) ? requested : newId(prefix);
}

function findTab(doc, tabId) {
  const tab = doc.tabs.find((t) => t.id === tabId);
  if (!tab) throw new OpError(`no tab with id ${tabId}`);
  return tab;
}

export function findItem(doc, itemId) {
  for (const tab of doc.tabs) {
    const idx = tab.items.findIndex((i) => i.id === itemId);
    if (idx >= 0) return { tab, idx, item: tab.items[idx] };
  }
  throw new OpError(`no item with id ${itemId}`);
}

function tabFields(input, tab) {
  if ('title' in input) tab.title = str(input.title, 80) || tab.title;
  if ('emoji' in input) tab.emoji = str(input.emoji, 8);
  if ('description' in input) tab.description = str(input.description, 1000);
  if ('layout' in input) tab.layout = LAYOUTS.includes(input.layout) ? input.layout : 'cards';
  return tab;
}

// Applies one operation to doc in place. Returns a short human description and,
// for creations, the new id.
export function applyOp(doc, op, { author = '' } = {}) {
  if (!op || typeof op !== 'object') throw new OpError('operation must be an object');
  switch (op.type) {
    case 'set_plan_details': {
      for (const k of ['title', 'emoji', 'subtitle', 'summary']) {
        if (k in op) doc[k] = str(op[k], k === 'summary' ? 8000 : 200);
      }
      for (const k of ['start', 'end']) {
        if (k in op) {
          if (!isDate(str(op[k]))) throw new OpError(`${k} must be YYYY-MM-DD`);
          doc[k] = str(op[k]);
        }
      }
      if (Array.isArray(op.travellers)) doc.travellers = op.travellers.map((t) => str(t, 60)).slice(0, 30);
      return { text: 'Updated plan details' };
    }
    case 'add_tab': {
      const tab = tabFields(op, { id: pinnedId(doc, op.__id, 'tab'), title: 'New tab', emoji: '', layout: 'cards', description: '', items: [] });
      const after = op.after_tab_id ? doc.tabs.findIndex((t) => t.id === op.after_tab_id) : -1;
      if (after >= 0) doc.tabs.splice(after + 1, 0, tab); else doc.tabs.push(tab);
      return { text: `Added tab “${tab.title}”`, id: tab.id };
    }
    case 'update_tab': {
      const tab = tabFields(op, findTab(doc, op.tab_id));
      return { text: `Updated tab “${tab.title}”` };
    }
    case 'delete_tab': {
      const tab = findTab(doc, op.tab_id);
      if (tab.items.length && !op.move_items_to_tab_id) {
        throw new OpError('tab still has items; pass move_items_to_tab_id or delete the items first');
      }
      if (op.move_items_to_tab_id) {
        const dest = findTab(doc, op.move_items_to_tab_id);
        if (dest === tab) throw new OpError('cannot move items into the tab being deleted');
        dest.items.push(...tab.items);
      }
      doc.tabs = doc.tabs.filter((t) => t !== tab);
      return { text: `Removed tab “${tab.title}”` };
    }
    case 'reorder_tabs': {
      const ids = Array.isArray(op.tab_ids) ? op.tab_ids : [];
      const byId = new Map(doc.tabs.map((t) => [t.id, t]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const rest = doc.tabs.filter((t) => !ids.includes(t.id));
      doc.tabs = [...ordered, ...rest];
      return { text: 'Reordered tabs' };
    }
    case 'add_item': {
      const tab = findTab(doc, op.tab_id);
      const item = cleanItem(op.item || {});
      item.id = pinnedId(doc, op.__id, 'item');
      item.addedBy = str(author, 60);
      item.createdAt = item.updatedAt;
      if (item.price) item.priceHistory = [{ ...item.price, at: item.createdAt }];
      tab.items.push(item);
      return { text: `Added “${item.title}” to ${tab.title}`, id: item.id };
    }
    case 'update_item': {
      const { tab, idx, item } = findItem(doc, op.item_id);
      tab.items[idx] = cleanItem(op.changes || {}, item);
      return { text: `Updated “${tab.items[idx].title}”` };
    }
    case 'move_item': {
      const { tab, idx, item } = findItem(doc, op.item_id);
      const dest = findTab(doc, op.to_tab_id);
      tab.items.splice(idx, 1);
      const pos = Number.isInteger(op.position) ? Math.max(0, Math.min(op.position, dest.items.length)) : dest.items.length;
      dest.items.splice(pos, 0, item);
      return { text: `Moved “${item.title}” to ${dest.title}` };
    }
    case 'delete_item': {
      const { tab, idx, item } = findItem(doc, op.item_id);
      tab.items.splice(idx, 1);
      return { text: `Removed “${item.title}”` };
    }
    default:
      throw new OpError(`unknown operation ${op.type}`);
  }
}

// Applies a list of ops atomically: either all succeed or doc is unchanged.
export function applyOps(doc, ops, opts) {
  const draft = structuredClone(doc);
  const results = ops.map((op) => applyOp(draft, op, opts));
  return { doc: draft, results };
}
