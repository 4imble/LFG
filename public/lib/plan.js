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
// Decided on or in the running, but not paid for yet. Their money is counted
// apart from what is booked ("shortlisted" in the sums below).
const PENDING = ['shortlisted', 'confirmed'];

// A price is per person when it says so, or (for older items) when its note does.
export const isPerPerson = (price) => (price?.per ? price.per === 'person' : /\b(per person|pp|p\.p\.|each|per head|per adult)\b/i.test(price?.note || ''));
// What a price costs the whole group.
export const groupAmount = (price, people = 1) => price.amount * (isPerPerson(price) ? Math.max(1, people) : 1);
const addTo = (sums, price, people) => { sums[price.currency] = (sums[price.currency] || 0) + groupAmount(price, people); };

// Sums prices per currency for `people` travellers: what is booked, and what
// is confirmed or shortlisted on top.
export function totals(items, people = 1) {
  const out = { booked: {}, shortlisted: {} };
  for (const i of items) {
    if (!i.price) continue;
    if (COMMITTED.includes(i.status)) addTo(out.booked, i.price, people);
    else if (PENDING.includes(i.status)) addTo(out.shortlisted, i.price, people);
  }
  return out;
}

// The same sums broken down by item kind, biggest first. Kinds with no money are left out.
export function spendByKind(items, people = 1) {
  const kinds = new Map();
  for (const i of items) {
    if (!i.price || !(COMMITTED.includes(i.status) || PENDING.includes(i.status))) continue;
    if (!kinds.has(i.kind)) kinds.set(i.kind, { kind: i.kind, booked: {}, shortlisted: {} });
    addTo(kinds.get(i.kind)[PENDING.includes(i.status) ? 'shortlisted' : 'booked'], i.price, people);
  }
  const size = (k) => Object.values(k.booked).concat(Object.values(k.shortlisted)).reduce((x, y) => x + y, 0);
  return [...kinds.values()].sort((x, y) => size(y) - size(x));
}

// How the money in the budget's own currency compares with the budget.
// Amounts in other currencies can't be converted, so they are listed apart.
export function budgetUse(doc, sums) {
  if (!doc.budget?.amount) return null;
  const { amount, currency } = doc.budget;
  const booked = sums.booked[currency] || 0;
  const shortlisted = sums.shortlisted[currency] || 0;
  const other = {};
  for (const group of [sums.booked, sums.shortlisted]) for (const [c, a] of Object.entries(group)) if (c !== currency) other[c] = (other[c] || 0) + a;
  return { amount, currency, booked, shortlisted, left: amount - booked - shortlisted, other };
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

// ---------- trip at a glance ----------
const addDays = (date, n) => new Date(parseDate(date).getTime() + n * 864e5).toISOString().slice(0, 10);
const live = (i) => i.status !== 'rejected';

// Which nights of the trip have somewhere to stay. A stay from the 8th to the
// 13th covers the nights of the 8th to the 12th. Gaps are runs of nights with
// no stay at all (booked or not).
export function stayCoverage(doc) {
  if (!isFullDate(doc.start) || !isFullDate(doc.end) || doc.end <= doc.start) return null;
  const nightsTotal = daysBetween(doc.start, doc.end);
  if (nightsTotal > 800) return null;
  const state = new Array(nightsTotal).fill(0); // 0 nothing, 1 a stay in mind, 2 booked
  for (const i of allItems(doc)) {
    if (i.kind !== 'stay' || !live(i) || !isFullDate(i.date) || !isFullDate(i.endDate) || i.endDate <= i.date) continue;
    const from = Math.max(0, daysBetween(doc.start, i.date));
    const to = Math.min(nightsTotal, daysBetween(doc.start, i.endDate));
    const level = COMMITTED.includes(i.status) ? 2 : 1;
    for (let n = from; n < to; n++) state[n] = Math.max(state[n], level);
  }
  const gaps = [];
  for (let n = 0; n < nightsTotal; n++) {
    if (state[n]) continue;
    const last = gaps[gaps.length - 1];
    if (last && last.index + last.nights === n) last.nights++;
    else gaps.push({ index: n, from: addDays(doc.start, n), nights: 1 });
  }
  for (const g of gaps) { g.to = addDays(g.from, g.nights); delete g.index; }
  return { nights: nightsTotal, covered: state.filter(Boolean).length, booked: state.filter((x) => x === 2).length, gaps };
}

// Lays the trip out as lanes of bars: where you are (places), where you sleep
// (stays) and travel days. Positions are percentages of the trip's length.
// Bars that overlap in a lane are pushed onto extra rows.
export function tripStrip(doc) {
  if (!isFullDate(doc.start) || !isFullDate(doc.end) || doc.end <= doc.start) return null;
  const days = daysBetween(doc.start, doc.end) + 1;
  if (days > 800) return null;
  const pct = (n) => Math.round((n / days) * 10000) / 100;
  const lanes = { place: [], stay: [], travel: [] };
  for (const i of allItems(doc)) {
    const lane = i.kind === 'place' ? 'place' : i.kind === 'stay' ? 'stay' : ['flight', 'transport'].includes(i.kind) ? 'travel' : null;
    if (!lane || !live(i) || !isFullDate(i.date)) continue;
    const end = isFullDate(i.endDate) && i.endDate > i.date ? i.endDate : i.date;
    if (end < doc.start || i.date > doc.end) continue;
    const from = Math.max(0, daysBetween(doc.start, i.date));
    // A stay ends on the morning you leave; a place or a journey includes its last day.
    const to = Math.min(days, daysBetween(doc.start, end) + (lane === 'stay' && end !== i.date ? 0 : 1));
    lanes[lane].push({ id: i.id, title: i.title, status: i.status, country: i.country || '', date: i.date, endDate: end, from, to, left: pct(from), width: pct(Math.max(to - from, 0.6)), row: 0 });
  }
  for (const bars of Object.values(lanes)) {
    bars.sort((a, b) => a.from - b.from || b.to - a.to);
    const rowEnds = [];
    for (const bar of bars) {
      let row = rowEnds.findIndex((end) => end <= bar.from);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = Math.max(bar.to, bar.from + 1);
      bar.row = row;
    }
  }
  const months = [];
  for (let d = parseDate(`${doc.start.slice(0, 7)}-01`); d <= parseDate(doc.end); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = d.toISOString().slice(0, 10);
    months.push({ key: key.slice(0, 7), left: pct(Math.max(0, daysBetween(doc.start, key))) });
  }
  const countries = [...new Set([...lanes.place, ...lanes.stay].sort((a, b) => a.from - b.from).map((b) => b.country).filter(Boolean))];
  return { days, lanes, months, countries, rows: Object.fromEntries(Object.entries(lanes).map(([k, bars]) => [k, bars.reduce((n, b) => Math.max(n, b.row + 1), 0)])) };
}

// What needs attention soonest: overdue to-dos first, then the next dated things.
export function nextUp(doc, today, limit = 5) {
  const todoTabs = new Set(doc.tabs.filter((t) => t.layout === 'list').map((t) => t.id));
  const dated = allItems(doc).filter((i) => live(i) && i.status !== 'done' && isFullDate(i.date));
  const isTodo = (i) => i.kind === 'todo' || todoTabs.has(i.tabId);
  const overdue = dated.filter((i) => isTodo(i) && i.date < today).map((i) => ({ ...i, overdue: true }));
  const coming = dated.filter((i) => (i.endDate && isFullDate(i.endDate) ? i.endDate : i.date) >= today);
  const byDate = (a, b) => a.date.localeCompare(b.date);
  return [...overdue.sort(byDate), ...coming.sort(byDate)].slice(0, limit).map((i) => ({ ...i, inDays: daysBetween(today, i.date), todo: isTodo(i) }));
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
      i.price && `Price: ${money(i.price)}${isPerPerson(i.price) ? ' per person' : ''}${i.price.note ? ` (${i.price.note})` : ''}`,
      ...Object.entries(i.details || {}).map(([k, v]) => `${k}: ${v}`),
      i.description, ...(i.links || []).map((l) => l.url),
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT', `UID:${i.id}@lfg`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(end)}`,
      `SUMMARY:${icsText(i.title)}`,
      ...([i.location, i.country].some(Boolean) ? [`LOCATION:${icsText([i.location, i.country].filter(Boolean).join(', '))}`] : []),
      `DESCRIPTION:${icsText(notes)}`,
      `STATUS:${['confirmed', 'booked', 'done'].includes(i.status) ? 'CONFIRMED' : 'TENTATIVE'}`,
      'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
