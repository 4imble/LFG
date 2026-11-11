// The front end's pure helpers are plain ES modules, so they are tested here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { md, esc, money, dateRange, shortRange, nights, ago, plural } from '../public/lib/format.js';
import { searchItems, sortItems, totals, spendByKind, fmtTotals, tripPhase, tripDay, toICS, isPerPerson, budgetUse, stayCoverage, tripStrip, nextUp } from '../public/lib/plan.js';
import { diffDocs } from '../public/lib/diff.js';
import { emptyPlan, applyOp } from '../src/ops.js';

function samplePlan() {
  const doc = emptyPlan({ name: 'Sabbatical' });
  applyOp(doc, { type: 'set_plan_details', start: '2027-02-01', end: '2027-04-30' });
  const tab = doc.tabs[0].id;
  const add = (item) => applyOp(doc, { type: 'add_item', tab_id: tab, item }).id;
  const ids = {
    flight: add({ kind: 'flight', title: 'LHR → HND', status: 'booked', date: '2027-02-01', price: { amount: 585, currency: 'GBP' }, country: 'Japan', tags: ['long-haul'] }),
    stay: add({ kind: 'stay', title: 'Kyoto hotel', status: 'shortlisted', date: '2027-02-08', endDate: '2027-02-13', price: { amount: 610, currency: 'GBP' }, location: 'Kyoto, Sanjo', details: { Ref: 'RX-88213' } }),
    art: add({ kind: 'activity', title: 'teamLab', status: 'booked', date: '2027-02-04', price: { amount: 3800, currency: 'JPY' }, pinned: true }),
    idea: add({ kind: 'idea', title: 'Aurora trip', status: 'idea', date: '2027-03', price: { amount: 2000, currency: 'GBP' } }),
    no: add({ kind: 'flight', title: 'Via Singapore', status: 'rejected', date: '2027-02-02', price: { amount: 980, currency: 'GBP' } }),
  };
  return { doc, ids };
}

test('markdown is escaped and supports the small subset', () => {
  assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(md('**bold** and *soft* and `code`'), '<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>');
  assert.equal(md('- one\n- two\n1. first\n2. second'), '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
  assert.match(md('[site](https://example.com/a?b=1)'), /^<p><a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">site<\/a><\/p>$/);
  assert.match(md('see https://www.example.com/x'), />example\.com\/x<\/a>/);
  assert.doesNotMatch(md('[x](javascript:alert(1))'), /<a /);
  assert.equal(esc(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
});

test('money, dates and counts format the British way', () => {
  assert.equal(money({ amount: 585, currency: 'GBP' }), '£585');
  assert.equal(money({ amount: 12.5, currency: 'GBP' }), '£12.50');
  assert.equal(money({ amount: 5, currency: 'NOPE!' }), '5 NOPE!');
  assert.equal(dateRange('2027-02-08', '2027-02-13'), '8 Feb → 13 Feb');
  assert.equal(dateRange('2027-12-28', '2028-01-03'), '28 Dec → 3 Jan 2028');
  assert.equal(dateRange('2027-04', ''), 'April 2027');
  assert.equal(shortRange('2027-02-08', '2027-02-13'), '8–13 Feb');
  assert.equal(shortRange('2027-01-28', '2027-02-02'), '28 Jan – 2 Feb');
  assert.equal(nights('2027-02-08', '2027-02-13'), 5);
  assert.equal(nights('2027-02', '2027-02-13'), 0);
  assert.equal(plural(1, 'item'), '1 item');
  assert.equal(plural(2, 'item'), '2 items');
  assert.equal(ago('2027-01-01T00:00:00Z', Date.parse('2027-01-01T02:10:00Z')), '2h ago');
});

test('search matches every word across fields, tags and details', () => {
  const { doc, ids } = samplePlan();
  const found = (q) => searchItems(doc, q).map((i) => i.id);
  assert.deepEqual(found('kyoto'), [ids.stay]);
  assert.deepEqual(found('KYOTO sanjo'), [ids.stay]);
  assert.deepEqual(found('#long-haul'), [ids.flight]);
  assert.deepEqual(found('rx-88213'), [ids.stay]);
  assert.deepEqual(found('booked').sort(), [ids.flight, ids.art].sort());
  assert.deepEqual(found('kyoto flight'), []);
  assert.deepEqual(found('   '), []);
});

test('sorting keeps pinned first and puts blanks last', () => {
  const { doc, ids } = samplePlan();
  const { items } = doc.tabs[0];
  const order = (mode) => sortItems(items, mode).map((i) => i.id);
  assert.deepEqual(order('manual'), [ids.art, ids.flight, ids.stay, ids.idea, ids.no]);
  assert.deepEqual(order('date'), [ids.art, ids.flight, ids.no, ids.stay, ids.idea]);
  assert.deepEqual(order('price-asc'), [ids.art, ids.flight, ids.stay, ids.no, ids.idea]);
  assert.deepEqual(order('title')[1], ids.idea);
  assert.equal(items[0].id, ids.flight, 'the original array is left alone');
});

test('totals count booked and shortlisted money per currency', () => {
  const { doc } = samplePlan();
  const { items } = doc.tabs[0];
  assert.deepEqual(totals(items), { booked: { GBP: 585, JPY: 3800 }, shortlisted: { GBP: 610 } });
  assert.equal(fmtTotals(totals(items).booked), '£585 + JP¥3,800');
  assert.deepEqual(spendByKind(items).map((k) => k.kind), ['activity', 'stay', 'flight']);
});

test('trip timing', () => {
  const { doc } = samplePlan();
  assert.deepEqual(tripPhase(doc, '2027-01-22'), { phase: 'before', days: 10 });
  assert.deepEqual(tripPhase(doc, '2027-02-01'), { phase: 'during', day: 1, length: 89 });
  assert.deepEqual(tripPhase(doc, '2027-05-01'), { phase: 'after', length: 89 });
  assert.equal(tripPhase({ start: '' }, '2027-01-01'), null);
  assert.equal(tripDay(doc, '2027-02-08'), 8);
  assert.equal(tripDay(doc, '2027-01-31'), null);
  assert.equal(tripDay(doc, '2027-05-01'), null);
  assert.equal(tripDay(doc, '2027-03'), null);
});

test('calendar export has all-day events for dated, live items', () => {
  const { doc, ids } = samplePlan();
  const ics = toICS(doc, { now: new Date('2027-01-01T10:00:00Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3, 'month-only and rejected items are left out');
  assert.ok(ics.includes(`UID:${ids.stay}@lfg`));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20270208\r\nDTEND;VALUE=DATE:20270214'), 'end date is exclusive');
  assert.ok(ics.includes('LOCATION:Kyoto\\, Sanjo'));
  assert.ok(ics.includes('STATUS:CONFIRMED') && ics.includes('STATUS:TENTATIVE'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('version diff describes what changed', () => {
  const { doc, ids } = samplePlan();
  const next = structuredClone(doc);
  applyOp(next, { type: 'update_item', item_id: ids.stay, changes: { status: 'booked', price: { amount: 580, currency: 'GBP' } } });
  applyOp(next, { type: 'delete_item', item_id: ids.no });
  applyOp(next, { type: 'add_tab', title: 'Japan' });
  const lines = diffDocs(doc, next).join('\n');
  assert.match(lines, /New tab <strong> Japan/);
  assert.match(lines, /Kyoto hotel<\/strong>: status <code>shortlisted<\/code> → <code>booked<\/code>, price <code>£610<\/code> → <code>£580<\/code>/);
  assert.match(lines, /Removed <strong>Via Singapore/);
  assert.deepEqual(diffDocs(doc, doc), ['<div class="muted">No visible changes</div>']);
  assert.deepEqual(diffDocs(null, doc), ['<div class="add">Plan created</div>']);
});

test('per-person prices count for everyone, and the budget compares like with like', () => {
  const { doc } = samplePlan();
  const { items } = doc.tabs[0];
  assert.equal(isPerPerson({ amount: 1, per: 'person' }), true);
  assert.equal(isPerPerson({ amount: 1, per: 'total', note: 'each' }), false, 'an explicit choice beats the note');
  assert.equal(isPerPerson({ amount: 1, note: '£40 pp' }), true, 'older items are read from their note');
  assert.equal(isPerPerson({ amount: 1, note: 'return' }), false);
  applyOp(doc, { type: 'update_item', item_id: items[0].id, changes: { price: { amount: 585, currency: 'GBP', per: 'person' } } });
  const sums = totals(doc.tabs[0].items, 2);
  assert.deepEqual(sums, { booked: { GBP: 1170, JPY: 3800 }, shortlisted: { GBP: 610 } });
  assert.equal(budgetUse(doc, sums), null);
  applyOp(doc, { type: 'set_plan_details', budget: { amount: 2000, currency: 'gbp' } });
  assert.deepEqual(budgetUse(doc, sums), { amount: 2000, currency: 'GBP', booked: 1170, shortlisted: 610, left: 220, other: { JPY: 3800 } });
});

test('stay coverage finds the nights with nowhere to sleep', () => {
  const doc = emptyPlan();
  applyOp(doc, { type: 'set_plan_details', start: '2027-02-01', end: '2027-02-11' });
  assert.deepEqual(stayCoverage(doc), { nights: 10, covered: 0, booked: 0, gaps: [{ from: '2027-02-01', nights: 10, to: '2027-02-11' }] });
  const add = (item) => applyOp(doc, { type: 'add_item', tab_id: doc.tabs[0].id, item: { kind: 'stay', ...item } });
  add({ title: 'A', status: 'booked', date: '2027-02-01', endDate: '2027-02-04' });
  add({ title: 'B', status: 'shortlisted', date: '2027-02-03', endDate: '2027-02-06' });
  add({ title: 'Rejected', status: 'rejected', date: '2027-02-06', endDate: '2027-02-11' });
  add({ title: 'Before the trip', status: 'booked', date: '2027-01-28', endDate: '2027-01-31' });
  add({ title: 'Last night', status: 'booked', date: '2027-02-10', endDate: '2027-02-12' });
  assert.deepEqual(stayCoverage(doc), { nights: 10, covered: 6, booked: 4, gaps: [{ from: '2027-02-06', nights: 4, to: '2027-02-10' }] });
  assert.equal(stayCoverage(emptyPlan()), null);
});

test('the trip strip positions bars and stacks overlaps', () => {
  const doc = emptyPlan();
  applyOp(doc, { type: 'set_plan_details', start: '2027-02-01', end: '2027-02-10' });
  const add = (item) => applyOp(doc, { type: 'add_item', tab_id: doc.tabs[0].id, item }).id;
  const tokyo = add({ kind: 'place', title: 'Tokyo', date: '2027-02-01', endDate: '2027-02-05', country: 'Japan' });
  const kyoto = add({ kind: 'place', title: 'Kyoto', date: '2027-02-04', endDate: '2027-02-08', country: 'Japan' });
  const hanoi = add({ kind: 'place', title: 'Hanoi', date: '2027-02-09', country: 'Vietnam' });
  add({ kind: 'flight', title: 'Flight', date: '2027-02-09' });
  add({ kind: 'place', title: 'Month only', date: '2027-02' });
  add({ kind: 'activity', title: 'Not a place', date: '2027-02-02' });
  const strip = tripStrip(doc);
  assert.equal(strip.days, 10);
  const byId = Object.fromEntries(strip.lanes.place.map((b) => [b.id, b]));
  assert.deepEqual([byId[tokyo].left, byId[tokyo].width, byId[tokyo].row], [0, 50, 0]);
  assert.deepEqual([byId[kyoto].left, byId[kyoto].row], [30, 1], 'overlapping bars go on a second row');
  assert.deepEqual([byId[hanoi].left, byId[hanoi].width, byId[hanoi].row], [80, 10, 0]);
  assert.equal(strip.lanes.place.length, 3);
  assert.equal(strip.lanes.travel.length, 1);
  assert.deepEqual(strip.rows, { place: 2, stay: 0, travel: 1 });
  assert.deepEqual(strip.countries, ['Japan', 'Vietnam']);
  assert.deepEqual(strip.months, [{ key: '2027-02', left: 0 }]);
  assert.equal(tripStrip(emptyPlan()), null);
});

test('next up lists overdue to-dos, then what is coming', () => {
  const doc = emptyPlan();
  const add = (item) => applyOp(doc, { type: 'add_item', tab_id: doc.tabs[0].id, item });
  add({ kind: 'todo', title: 'Insurance', date: '2027-01-10' });
  add({ kind: 'todo', title: 'Passports', date: '2026-12-01', status: 'done' });
  add({ kind: 'flight', title: 'Fly', date: '2027-02-01' });
  add({ kind: 'place', title: 'Old trip', date: '2026-06-01' });
  add({ kind: 'stay', title: 'Staying now', date: '2027-01-18', endDate: '2027-01-25' });
  const list = nextUp(doc, '2027-01-20');
  assert.deepEqual(list.map((i) => [i.title, i.inDays, Boolean(i.overdue)]), [['Insurance', -10, true], ['Staying now', -2, false], ['Fly', 12, false]]);
});

test('"confirmed" items are decided but not booked: counted with the shortlist, firm on the calendar', () => {
  const { doc } = samplePlan();
  const tab = doc.tabs[0].id;
  applyOp(doc, { type: 'add_item', tab_id: tab, item: { kind: 'activity', title: 'Therme', status: 'confirmed', date: '2027-01-20', price: { amount: 40, currency: 'GBP', per: 'person' } } });
  const items = doc.tabs.flatMap((t) => t.items);
  assert.deepEqual(totals(items, 2), { booked: { GBP: 585, JPY: 3800 }, shortlisted: { GBP: 690 } });
  assert.deepEqual(spendByKind(items, 2).find((k) => k.kind === 'activity'), { kind: 'activity', booked: { JPY: 3800 }, shortlisted: { GBP: 80 } });
  const ics = toICS(doc, { now: new Date('2027-01-01T10:00:00Z') });
  assert.match(ics, /SUMMARY:Therme\r\n(?:.*\r\n)*?STATUS:CONFIRMED/);
});
