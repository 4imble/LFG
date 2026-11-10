import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { makeAuth } from './auth.js';
import { applyOp, applyOps, OpError } from './ops.js';
import { aiEnabled, runAssistant } from './ai.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db, password, secret }) {
  const app = express();
  const auth = makeAuth({ password, secret });
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  const who = (req) => {
    let n = String(req.get('x-lfg-name') || '');
    try { n = decodeURIComponent(n); } catch { /* keep raw */ }
    return n.trim().slice(0, 40) || 'Someone';
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/login', (req, res) => {
    const result = auth.checkPassword(req, req.body?.password);
    if (!result.ok) {
      if (result.retryAfter) res.setHeader('Retry-After', result.retryAfter);
      return res.status(result.retryAfter ? 429 : 401).json({ error: result.retryAfter ? 'Too many attempts, try again later' : 'Wrong password' });
    }
    auth.issue(req, res);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => { auth.logout(res); res.json({ ok: true }); });

  app.use('/api', (req, res, next) => (auth.valid(req) ? next() : res.status(401).json({ error: 'Not signed in' })));

  app.get('/api/session', (_req, res) => res.json({ ok: true, ai: aiEnabled() }));

  app.get('/api/plans', async (_req, res) => res.json(await db.listPlans()));

  app.post('/api/plans', async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100) || 'New plan';
    const emoji = String(req.body?.emoji || '🧭').slice(0, 8);
    res.json(await db.createPlan({ name, emoji, author: who(req) }));
  });

  const loadPlan = async (req, res) => {
    const plan = await db.getPlan(req.params.id);
    if (!plan) res.status(404).json({ error: 'No such plan' });
    return plan;
  };

  app.get('/api/plans/:id', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (plan) res.json(plan);
  });

  app.post('/api/plans/:id/archive', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (!plan) return;
    await db.setArchived(plan.id, Boolean(req.body?.archived));
    res.json({ ok: true });
  });

  // Apply manual edits. Edits are applied to the latest saved plan, so two
  // people editing different things at once both keep their changes.
  app.post('/api/plans/:id/ops', async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (!ops.length) return res.status(400).json({ error: 'No changes' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const plan = await loadPlan(req, res);
      if (!plan) return;
      let out;
      try {
        out = applyOps(plan.doc, ops, { author: who(req) });
      } catch (err) {
        if (err instanceof OpError) return res.status(400).json({ error: err.message });
        throw err;
      }
      const summary = String(req.body?.summary || out.results.map((r) => r.text).join('; '));
      const version = await db.savePlan(plan.id, plan.version, out.doc, { author: who(req), source: 'manual', summary });
      if (version) return res.json({ id: plan.id, version, doc: out.doc, results: out.results });
    }
    res.status(409).json({ error: 'The plan is busy, try again' });
  });

  app.get('/api/plans/:id/versions', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (!plan) return;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    res.json({ current: plan.version, versions: await db.listVersions(plan.id, limit, offset) });
  });

  app.get('/api/plans/:id/versions/:n', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (!plan) return;
    const n = Number(req.params.n);
    const v = await db.getVersion(plan.id, n);
    if (!v) return res.status(404).json({ error: 'No such version' });
    const prev = n > 1 ? await db.getVersion(plan.id, n - 1) : null;
    res.json({ ...v, previous: prev?.doc || null });
  });

  app.post('/api/plans/:id/versions/:n/restore', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (!plan) return;
    const v = await db.getVersion(plan.id, Number(req.params.n));
    if (!v) return res.status(404).json({ error: 'No such version' });
    const version = await db.savePlan(plan.id, plan.version, v.doc, {
      author: who(req), source: 'restore', summary: `Restored version ${v.n}`,
    });
    if (!version) return res.status(409).json({ error: 'The plan changed, try again' });
    res.json({ id: plan.id, version, doc: v.doc });
  });

  app.get('/api/plans/:id/chat', async (req, res) => {
    const plan = await loadPlan(req, res);
    if (plan) res.json(await db.listChat(plan.id));
  });

  const running = new Set();
  app.post('/api/plans/:id/ai', async (req, res, next) => {
    if (!aiEnabled()) return res.status(503).json({ error: 'The assistant is not set up: ANTHROPIC_API_KEY is missing' });
    const plan = await loadPlan(req, res);
    if (!plan) return;
    const message = String(req.body?.message || '').trim().slice(0, 20000);
    if (!message) return res.status(400).json({ error: 'Say something first' });
    if (running.has(plan.id)) return res.status(409).json({ error: 'The assistant is already working on this plan' });
    running.add(plan.id);
    const author = who(req);
    try {
      const chat = await db.listChat(plan.id, 20);
      const result = await runAssistant({ doc: plan.doc, message, author, chat });
      let saved = null;
      if (result.ops.length) {
        const summary = `Assistant: ${result.results.join('; ')}`.slice(0, 2000);
        const meta = { author: `AI (for ${author})`, source: 'ai', summary };
        let version = await db.savePlan(plan.id, plan.version, result.draft, meta);
        let doc = result.draft;
        // Someone edited while the assistant worked: replay its changes on top.
        for (let attempt = 0; !version && attempt < 3; attempt++) {
          const latest = await db.getPlan(plan.id);
          doc = structuredClone(latest.doc);
          for (const op of result.ops) {
            try { applyOp(doc, op, { author: meta.author }); } catch { /* skip ops that no longer apply */ }
          }
          version = await db.savePlan(plan.id, latest.version, doc, meta);
        }
        saved = version ? { version, doc } : null;
      }
      await db.addChat(plan.id, { role: 'user', author, text: message });
      await db.addChat(plan.id, { role: 'assistant', author: 'AI', text: result.reply, version: saved?.version ?? null });
      const fresh = await db.getPlan(plan.id);
      res.json({ reply: result.reply, changes: result.results, version: fresh.version, doc: fresh.doc });
    } catch (err) {
      next(err);
    } finally {
      running.delete(plan.id);
    }
  });

  app.use(express.static(join(root, 'public'), { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(root, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status === 401 ? 502 : status).json({ error: err?.message || 'Something went wrong' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    console.error('APP_PASSWORD must be set');
    process.exit(1);
  }
  const db = await openDb(process.env.DATABASE_URL);
  const app = createApp({ db, password, secret: process.env.SESSION_SECRET });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`LFG listening on :${port}${aiEnabled() ? '' : ' (assistant off: no ANTHROPIC_API_KEY)'}`));
}
