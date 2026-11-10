// Runs against a real Postgres: TEST_DATABASE_URL=postgres://... npm test
// The assistant is exercised against a fake Anthropic API on localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;

test('API end to end', { skip: !url && 'TEST_DATABASE_URL not set' }, async (t) => {
  const reset = new pg.Client({ connectionString: url });
  await reset.connect();
  await reset.query('DROP TABLE IF EXISTS chat, versions, plans, settings, schema_migrations CASCADE');
  await reset.end();

  // Fake Messages API: first call adds a tab, second replies with text.
  let calls = 0;
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      const reqBody = JSON.parse(body);
      seen.push(reqBody);
      const toolUse = calls === 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: `msg_${calls}`, type: 'message', role: 'assistant', model: reqBody.model,
        stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: toolUse
          ? [{ type: 'tool_use', id: 'tu_1', name: 'add_tab', input: { title: 'Flights', emoji: '✈️', layout: 'table' } }]
          : [{ type: 'text', text: 'Added a Flights tab.' }],
      }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

  const { openDb } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const db = await openDb(url);
  await openDb(url).then((d) => d.close()); // migrations are idempotent
  const server = createApp({ db, password: 'pw' }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => { server.close(); fake.close(); await db.close(); });

  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', cookie, 'x-lfg-name': encodeURIComponent('Zoë') },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), res };
  };

  assert.equal((await call('/plans')).status, 401);
  assert.equal((await call('/login', { password: 'nope' })).status, 401);
  const login = await call('/login', { password: 'pw' });
  assert.equal(login.status, 200);
  cookie = login.res.headers.get('set-cookie').split(';')[0];

  const plan = (await call('/plans', { name: 'Sabbatical 2027', emoji: '🌏' })).body;
  assert.equal(plan.version, 1);
  const inbox = plan.doc.tabs[0].id;

  const added = await call(`/plans/${plan.id}/ops`, { ops: [{ type: 'add_item', tab_id: inbox, item: { title: 'Vietnam', kind: 'place' } }] });
  assert.equal(added.status, 200);
  assert.equal(added.body.version, 2);
  assert.equal(added.body.doc.tabs[0].items[0].addedBy, 'Zoë');

  const bad = await call(`/plans/${plan.id}/ops`, { ops: [{ type: 'delete_item', item_id: 'item_nope' }] });
  assert.equal(bad.status, 400);

  assert.equal((await call('/settings/assistant', { model: 'gpt-9', effort: 'low' })).status, 400);
  const saved = await call('/settings/assistant', { model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(saved.status, 200);
  assert.equal((await call('/settings/assistant')).body.model, 'claude-haiku-5-5');

  const ai = await call(`/plans/${plan.id}/ai`, { message: 'make a flights tab' });
  assert.equal(seen[0].model, 'claude-haiku-5-5');
  assert.equal(seen[0].output_config.effort, 'low');
  assert.equal(seen[0].fallbacks, undefined);
  assert.ok(seen[0].tools.some((tl) => tl.type === 'web_search_20250305'));
  assert.equal(ai.status, 200, JSON.stringify(ai.body));
  assert.equal(ai.body.reply, 'Added a Flights tab.');
  assert.equal(ai.body.version, 3);
  assert.ok(ai.body.doc.tabs.some((tb) => tb.title === 'Flights'));

  const versions = (await call(`/plans/${plan.id}/versions`)).body;
  assert.deepEqual(versions.versions.map((v) => v.source), ['ai', 'manual', 'manual']);
  assert.equal(versions.versions[0].author, 'AI (for Zoë)');

  const chat = (await call(`/plans/${plan.id}/chat`)).body;
  assert.deepEqual(chat.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat[1].version, 3);

  const restored = await call(`/plans/${plan.id}/versions/1/restore`, {});
  assert.equal(restored.body.version, 4);
  assert.equal(restored.body.doc.tabs[0].items.length, 0);

  const list = (await call('/plans')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].hasPassword, false);
  assert.equal(list[0].password_hash, undefined);

  // Per-plan passwords: a plan password unlocks only that plan.
  const other = (await call('/plans', { name: 'Friends holiday' })).body;
  assert.equal((await call(`/plans/${plan.id}/password`, { password: 'abc' })).status, 400);
  assert.equal((await call(`/plans/${plan.id}/password`, { password: 'sabbatical!' })).status, 200);
  const admin = cookie;

  cookie = '';
  assert.equal((await call('/login', { password: 'wrong-one' })).status, 401);
  const guest = await call('/login', { password: 'sabbatical!' });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.admin, false);
  cookie = guest.res.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await call('/plans')).body.map((p) => p.id), [plan.id]);
  assert.equal((await call(`/plans/${plan.id}`)).status, 200);
  assert.equal((await call(`/plans/${plan.id}/ops`, { ops: [{ type: 'set_plan_details', subtitle: 'by guest' }] })).status, 200);
  const locked = await call(`/plans/${other.id}`);
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
  assert.equal((await call(`/plans/${other.id}/versions`)).status, 403);
  assert.equal((await call('/plans', { name: 'Sneaky' })).status, 403);
  assert.equal((await call('/settings/assistant')).status, 403);
  assert.equal((await call(`/plans/${plan.id}/password`, { password: 'hijacked' })).status, 403);
  const guestCookie = cookie;

  // Resetting the password signs the guest out of that plan.
  cookie = admin;
  await call(`/plans/${plan.id}/password`, { password: 'new-secret' });
  cookie = guestCookie;
  assert.equal((await call(`/plans/${plan.id}`)).status, 403);

  // Undo: a restore with ifVersion is refused once the plan has moved on.
  cookie = admin;
  const current = (await call(`/plans/${plan.id}`)).body.version;
  const stale = await call(`/plans/${plan.id}/versions/1/restore`, { ifVersion: current - 1 });
  assert.equal(stale.status, 409);
  assert.equal((await call(`/plans/${plan.id}/versions/1/restore`, { ifVersion: current })).body.version, current + 1);
  assert.equal((await call(`/plans/${plan.id}/versions/abc`)).status, 404);

  // The assistant can stream its progress as newline-delimited JSON.
  calls = 0;
  const streamed = await fetch(`${base}/plans/${plan.id}/ai`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message: 'flights tab please', stream: true }),
  });
  assert.match(streamed.headers.get('content-type'), /ndjson/);
  const events = (await streamed.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['start', 'step', 'done']);
  assert.equal(events[1].text, 'Added tab “Flights”');
  assert.equal(events[2].savedVersion, events[2].version);
  assert.ok(events[2].doc.tabs.some((tb) => tb.title === 'Flights'));

  // Deleting a plan is admin only and needs its exact name.
  cookie = guestCookie;
  const del = (path, body) => fetch(base + path, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await del(`/plans/${other.id}`, { confirm: 'Friends holiday' })).status, 403);
  cookie = admin;
  assert.equal((await del(`/plans/${other.id}`, { confirm: 'friends' })).status, 400);
  assert.equal((await del(`/plans/${other.id}`, { confirm: 'Friends holiday' })).status, 200);
  assert.deepEqual((await call('/plans')).body.map((p) => p.id), [plan.id]);

  // The page links its assets under a per-build path, which can be cached
  // for ever; the page itself is always revalidated.
  const origin = base.replace('/api', '');
  const page = await fetch(origin);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text();
  const [, asset] = html.match(/src="(\/v\/[0-9a-f]+\/app\.js)"/);
  assert.match(html, /href="\/v\/[0-9a-f]+\/styles\.css"/);
  const js = await fetch(origin + asset);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${origin}/v/oldbuild/lib/format.js`)).status, 200);
  assert.equal((await fetch(`${origin}/api/nope`, { headers: { cookie } })).status, 404);
  assert.match((await (await fetch(`${origin}/some/deep/link`)).text()), /<div id="app">/);
});
