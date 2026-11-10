import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, applyOp, applyOps, OpError } from '../src/ops.js';

test('add, update price (keeps history), move and delete items', () => {
  const doc = emptyPlan({ name: 'Sabbatical' });
  const inbox = doc.tabs[0].id;
  const { id: tabId } = applyOp(doc, { type: 'add_tab', title: 'Flights', layout: 'table' });
  const { id } = applyOp(doc, { type: 'add_item', tab_id: inbox, item: { kind: 'flight', title: 'LHR → BKK', price: { amount: 640, currency: 'gbp' } } }, { author: 'Sam' });
  applyOp(doc, { type: 'update_item', item_id: id, changes: { price: { amount: 580, currency: 'GBP' } } });
  const item = doc.tabs[0].items[0];
  assert.equal(item.addedBy, 'Sam');
  assert.equal(item.price.amount, 580);
  assert.deepEqual(item.priceHistory.map((p) => p.amount), [640, 580]);
  applyOp(doc, { type: 'move_item', item_id: id, to_tab_id: tabId });
  assert.equal(doc.tabs[1].items[0].id, id);
  applyOp(doc, { type: 'delete_item', item_id: id });
  assert.equal(doc.tabs[1].items.length, 0);
});

test('validation errors leave the plan untouched', () => {
  const doc = emptyPlan();
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [
    { type: 'add_item', tab_id: doc.tabs[0].id, item: { title: 'ok' } },
    { type: 'add_item', tab_id: doc.tabs[0].id, item: { title: 'bad', date: 'next tuesday' } },
  ]), OpError);
  assert.equal(JSON.stringify(doc), before);
});

test('deleting a tab with items needs a destination', () => {
  const doc = emptyPlan();
  const inbox = doc.tabs[0].id;
  const { id: other } = applyOp(doc, { type: 'add_tab', title: 'Japan' });
  applyOp(doc, { type: 'add_item', tab_id: other, item: { title: 'Kyoto' } });
  assert.throws(() => applyOp(doc, { type: 'delete_tab', tab_id: other }), OpError);
  applyOp(doc, { type: 'delete_tab', tab_id: other, move_items_to_tab_id: inbox });
  assert.equal(doc.tabs.length, 1);
  assert.equal(doc.tabs[0].items[0].title, 'Kyoto');
});

test('links must be http(s) and replayed ops keep their ids', () => {
  const doc = emptyPlan();
  const op = { type: 'add_item', tab_id: doc.tabs[0].id, __id: 'item_abcdef1234', item: { title: 'x', links: ['javascript:alert(1)', 'https://example.com'] } };
  applyOp(doc, op);
  const item = doc.tabs[0].items[0];
  assert.equal(item.id, 'item_abcdef1234');
  assert.deepEqual(item.links.map((l) => l.url), ['https://example.com']);
});

test('budget, cover and per-person prices are validated', () => {
  const doc = emptyPlan();
  applyOp(doc, { type: 'set_plan_details', budget: { amount: '14000', currency: 'gbp' }, cover: 'https://example.com/a.jpg' });
  assert.deepEqual(doc.budget, { amount: 14000, currency: 'GBP' });
  assert.equal(doc.cover, 'https://example.com/a.jpg');
  applyOp(doc, { type: 'set_plan_details', budget: { amount: 0 }, cover: 'javascript:alert(1)' });
  assert.equal(doc.budget, null);
  assert.equal(doc.cover, '');
  applyOp(doc, { type: 'set_plan_details', title: 'Renamed' });
  assert.equal(doc.budget, null, 'fields that are not sent are left alone');

  const { id } = applyOp(doc, { type: 'add_item', tab_id: doc.tabs[0].id, item: { title: 'Flight', price: { amount: 500, currency: 'GBP', per: 'person' } } });
  const item = () => doc.tabs[0].items[0];
  assert.equal(item().price.per, 'person');
  applyOp(doc, { type: 'update_item', item_id: id, changes: { price: { amount: 500, currency: 'GBP', per: 'total', note: 'return' } } });
  assert.equal(item().price.per, 'total');
  assert.equal(item().priceHistory.length, 1, 'changing only the note or who it covers is not a price change');
  applyOp(doc, { type: 'update_item', item_id: id, changes: { price: { amount: 450, currency: 'GBP', per: 'sideways' } } });
  assert.equal(item().price.per, undefined);
  assert.deepEqual(item().priceHistory.map((p) => p.amount), [500, 450]);
});
