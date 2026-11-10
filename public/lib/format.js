// Pure formatting helpers. No DOM access, so they also run under node:test.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const hostOf = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

// Small, safe markdown subset: paragraphs, "- " and "1. " lists, "#" headings,
// **bold**, *italic*, `code`, [links](https://…) and bare links. Everything is
// escaped first, so no HTML from the text ever reaches the page.
export function md(text) {
  if (!text) return '';
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${hostOf(u).slice(0, 40)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const out = [];
  let list = null; // { tag, items }
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  for (const line of String(text).split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    const item = bullet || numbered;
    if (item) {
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flush();
      (list ||= { tag, items: [] }).items.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    flush();
    const heading = line.match(/^\s*#{1,4}\s+(.*)/);
    if (heading) out.push(`<p class="md-h"><strong>${inline(heading[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

export function money(p) {
  if (!p || p.amount == null) return '';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency || 'GBP', maximumFractionDigits: p.amount % 1 ? 2 : 0 }).format(p.amount);
  } catch { return `${p.amount} ${p.currency || ''}`.trim(); }
}

// Dates are "YYYY-MM-DD" or "YYYY-MM" strings and are always treated as UTC.
export function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
export const isFullDate = (s) => typeof s === 'string' && s.length === 10;
export const todayStr = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);

export function fmtDate(s, { short = false } = {}) {
  if (!s) return '';
  const d = parseDate(s);
  if (s.length === 7) return d.toLocaleDateString('en-GB', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}
export function dateRange(a, b) {
  if (!a && !b) return '';
  if (a && b) return `${fmtDate(a, { short: true })} → ${fmtDate(b, { short: b.startsWith(a.slice(0, 4)) })}`;
  return fmtDate(a || b);
}
// Compact range for tight spaces: "21–24 Jan", "28 Jan – 2 Feb".
export function shortRange(a, b) {
  if (!isFullDate(a) || !isFullDate(b)) return dateRange(a, b);
  const da = parseDate(a); const db = parseDate(b);
  const mon = (d) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const yr = da.getUTCFullYear() !== db.getUTCFullYear() ? ` ${db.getUTCFullYear()}` : '';
  if (!yr && da.getUTCMonth() === db.getUTCMonth()) return `${da.getUTCDate()}–${db.getUTCDate()} ${mon(db)}`;
  return `${da.getUTCDate()} ${mon(da)} – ${db.getUTCDate()} ${mon(db)}${yr}`;
}
// Whole nights between two full dates, or 0 when that makes no sense.
export function nights(a, b) {
  if (!isFullDate(a) || !isFullDate(b)) return 0;
  return Math.max(0, daysBetween(a, b));
}
export function ago(iso, now = Date.now()) {
  const s = (now - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
