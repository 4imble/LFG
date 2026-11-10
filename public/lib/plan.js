// Pure functions over a plan document: flattening, search, sorting, totals,
// trip timing and calendar export. No DOM access, so they run under node:test.

import { isFullDate, parseDate, daysBetween, money } from './format.js';

export const allItems = (doc) => doc.tabs.flatMap((t) => t.items.map((i) => ({ ...i, tabId: t.id, tabTitle: t.title })));

// Every word of the query must appear somewhere in the item. "#tag" matches tags.
export function searchItems(doc, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return allItems(doc).filter((i) => {
    const hay = [
      i.title, i.subtitle, i.description, i.location, i.country, i.kind, i.status, i.tabTitle, i.time,
      ...(i.tags || []).map((t) => `#${t}`), ...Object.entries(i.details || {}).flat(), ...(i.links || []).map((l) => l.label),
    ].filter(Boolean).join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const SORTS = { manual: 'Manual order', date: 'Date', 'price-asc': 'Price: low to high', 'price-desc': 'Price: high to low', title: 'Name', updated: 'Recently updated' };

// Sorts a copy. Pinned items always come first; items missing the sort field go last.
export function sortItems(items, mode = 'manual') {
  const missingLast = (get, dir = 1) => (a, b) => {
    const x = get(a); const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  };
  const by = {
    date: missingLast((i) => (i.date ? `${i.date}${i.date.length === 7 ? '-99' : ''} ${i.time || ''}` : null)),
    'price-asc': missingLast((i) => i.price?.amount ?? null),
    'price-desc': missingLast((i) => i.price?.amount ?? null, -1),
    title: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
    updated: missingLast((i) => i.updatedAt || null, -1),
  }[mode];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (Boolean(b.item.pinned) - Boolean(a.item.pinned)) || (by ? by(a.item, b.item) : 0) || a.index - b.index)
    .map((x) => x.item);
}

const COMMITTED = ['booked', 'done'];
const addTo = (totals, price) => { totals[price.currency] = (totals[price.currency] || 0) + price.amount; };

// Sums prices per currency: what is booked, and what is shortlisted on top.
export function totals(items) {
  const out = { booked: {}, shortlisted: {} };
  for (const i of items) {
    if (!i.price) continue;
    if (COMMITTED.includes(i.status)) addTo(out.booked, i.price);
    else if (i.status === 'shortlisted') addTo(out.shortlisted, i.price);
  }
  return out;
}

// The same sums broken down by item kind, biggest first. Kinds with no money are left out.
export function spendByKind(items) {
  const kinds = new Map();
  for (const i of items) {
    if (!i.price || !(COMMITTED.includes(i.status) || i.status === 'shortlisted')) continue;
    if (!kinds.has(i.kind)) kinds.set(i.kind, { kind: i.kind, booked: {}, shortlisted: {} });
    addTo(kinds.get(i.kind)[i.status === 'shortlisted' ? 'shortlisted' : 'booked'], i.price);
  }
  const size = (k) => Object.values(k.booked).concat(Object.values(k.shortlisted)).reduce((a, b) => a + b, 0);
  return [...kinds.values()].sort((a, b) => size(b) - size(a));
}

export const fmtTotals = (t) => Object.entries(t).map(([currency, amount]) => money({ amount, currency })).join(' + ');

// Where "today" sits relative to the trip: before it, during it or after it.
export function tripPhase(doc, today) {
  if (!isFullDate(doc.start)) return null;
  const toStart = daysBetween(today, doc.start);
  if (toStart > 0) return { phase: 'before', days: toStart };
  const length = isFullDate(doc.end) ? daysBetween(doc.start, doc.end) + 1 : null;
  if (length != null && daysBetween(doc.start, today) >= length) return { phase: 'after', length };
  if (length == null) return null;
  return { phase: 'during', day: daysBetween(doc.start, today) + 1, length };
}

// "Day 12" of the trip for a dated item, or null when it falls outside the trip.
export function tripDay(doc, date) {
  if (!isFullDate(doc.start) || !isFullDate(date)) return null;
  const n = daysBetween(doc.start, date) + 1;
  if (n < 1 || (isFullDate(doc.end) && date > doc.end)) return null;
  return n;
}

// ---------- calendar export ----------
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDate = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
// Lines may be at most 75 bytes; longer ones continue on a line starting with a space.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

// All-day calendar events for every dated item that hasn't been rejected.
export function toICS(doc, { now = new Date() } = {}) {
  const stamp = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LFG//Trip planner//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(doc.title)}`];
  for (const i of allItems(doc)) {
    if (!isFullDate(i.date) || i.status === 'rejected') continue;
    const start = parseDate(i.date);
    const last = isFullDate(i.endDate) && i.endDate >= i.date ? parseDate(i.endDate) : start;
    const end = new Date(last.getTime() + 864e5); // DTEND is exclusive
    const notes = [
      i.subtitle, i.time && `Time: ${i.time}`, `Status: ${i.status}`,
      i.price && `Price: ${money(i.price)}${i.price.note ? ` (${i.price.note})` : ''}`,
      ...Object.entries(i.details || {}).map(([k, v]) => `${k}: ${v}`),
      i.description, ...(i.links || []).map((l) => l.url),
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT', `UID:${i.id}@lfg`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(end)}`,
      `SUMMARY:${icsText(i.title)}`,
      ...([i.location, i.country].some(Boolean) ? [`LOCATION:${icsText([i.location, i.country].filter(Boolean).join(', '))}`] : []),
      `DESCRIPTION:${icsText(notes)}`,
      `STATUS:${['booked', 'done'].includes(i.status) ? 'CONFIRMED' : 'TENTATIVE'}`,
      'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
