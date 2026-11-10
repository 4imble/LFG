// Postgres storage (connection from DATABASE_URL). Each plan keeps its current
// document plus a full snapshot for every saved change, which powers the
// history page and restores. Schema changes live in MIGRATIONS and run on start.

import pg from 'pg';
import { emptyPlan, newId } from './ops.js';

// Append new migrations to the end. Never edit one that has shipped.
const MIGRATIONS = [
  `CREATE TABLE plans (
     id TEXT PRIMARY KEY,
     doc JSONB NOT NULL,
     version INTEGER NOT NULL,
     archived BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE versions (
     plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
     n INTEGER NOT NULL,
     doc JSONB NOT NULL,
     author TEXT NOT NULL,
     source TEXT NOT NULL,
     summary TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (plan_id, n)
   );
   CREATE TABLE chat (
     id BIGSERIAL PRIMARY KEY,
     plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     author TEXT NOT NULL,
     text TEXT NOT NULL,
     version INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX chat_plan_idx ON chat (plan_id, id);`,
  'ALTER TABLE plans ADD COLUMN password_hash TEXT',
];

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    // An advisory lock stops two app instances migrating at the same time.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (n INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT COALESCE(MAX(n), 0) AS n FROM schema_migrations');
    const done = Number(rows[0].n);
    for (let n = done + 1; n <= MIGRATIONS.length; n++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[n - 1]);
        await client.query('INSERT INTO schema_migrations (n) VALUES ($1)', [n]);
        await client.query('COMMIT');
        console.log(`Applied migration ${n}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

export async function openDb(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL must be set');
  const ssl = /sslmode=(require|verify)/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, ssl, max: 5 });
  await migrate(pool);

  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  const planRow = (r) => r && { id: r.id, doc: r.doc, version: r.version, archived: r.archived, updated_at: iso(r.updated_at), password_hash: r.password_hash };

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query(out === null ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async listPlans() {
      const { rows } = await pool.query('SELECT id, doc, version, archived, updated_at, password_hash FROM plans ORDER BY archived, updated_at DESC');
      return rows.map((r) => ({
        id: r.id, version: r.version, archived: r.archived, updated_at: iso(r.updated_at), password_hash: r.password_hash,
        title: r.doc.title, emoji: r.doc.emoji, subtitle: r.doc.subtitle, start: r.doc.start, end: r.doc.end,
        itemCount: r.doc.tabs.reduce((n, t) => n + t.items.length, 0),
      }));
    },
    async getPlan(id) {
      const { rows } = await pool.query('SELECT id, doc, version, archived, updated_at, password_hash FROM plans WHERE id = $1', [id]);
      return planRow(rows[0]);
    },
    async createPlan({ name, emoji, author }) {
      const id = newId('plan');
      const doc = emptyPlan({ name, emoji });
      await tx(async (c) => {
        await c.query('INSERT INTO plans (id, doc, version) VALUES ($1, $2, 1)', [id, doc]);
        await c.query("INSERT INTO versions (plan_id, n, doc, author, source, summary) VALUES ($1, 1, $2, $3, 'manual', 'Created plan')", [id, doc, author]);
      });
      return this.getPlan(id);
    },
    // Saves a new version. Returns null if someone else saved first.
    async savePlan(id, expectedVersion, doc, { author, source, summary }) {
      const next = expectedVersion + 1;
      return tx(async (c) => {
        const res = await c.query('UPDATE plans SET doc = $1, version = $2, updated_at = now() WHERE id = $3 AND version = $4', [doc, next, id, expectedVersion]);
        if (res.rowCount !== 1) return null;
        await c.query('INSERT INTO versions (plan_id, n, doc, author, source, summary) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, next, doc, author, source, summary.slice(0, 2000)]);
        return next;
      });
    },
    async listPlanPasswords() {
      const { rows } = await pool.query('SELECT id, password_hash FROM plans WHERE password_hash IS NOT NULL');
      return rows;
    },
    async setPlanPassword(id, passwordHash) {
      await pool.query('UPDATE plans SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    },
    async setArchived(id, archived) {
      await pool.query('UPDATE plans SET archived = $1 WHERE id = $2', [archived, id]);
    },
    async listVersions(id, limit = 100, offset = 0) {
      const { rows } = await pool.query('SELECT n, author, source, summary, created_at FROM versions WHERE plan_id = $1 ORDER BY n DESC LIMIT $2 OFFSET $3', [id, limit, offset]);
      return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
    },
    async getVersion(id, n) {
      const { rows } = await pool.query('SELECT n, doc, author, source, summary, created_at FROM versions WHERE plan_id = $1 AND n = $2', [id, n]);
      return rows[0] && { ...rows[0], created_at: iso(rows[0].created_at) };
    },
    async addChat(planId, { role, author, text, version = null }) {
      await pool.query('INSERT INTO chat (plan_id, role, author, text, version) VALUES ($1, $2, $3, $4, $5)', [planId, role, author, text, version]);
    },
    async listChat(planId, limit = 40) {
      const { rows } = await pool.query('SELECT * FROM (SELECT id, role, author, text, version, created_at FROM chat WHERE plan_id = $1 ORDER BY id DESC LIMIT $2) c ORDER BY id', [planId, limit]);
      return rows.map((r) => ({ ...r, id: Number(r.id), created_at: iso(r.created_at) }));
    },
    close() { return pool.end(); },
  };
}
