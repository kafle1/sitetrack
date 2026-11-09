import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db';

const dir = path.join(__dirname, '..', 'migrations');

export async function migrate(log: (m: string) => void) {
  const c = await pool.connect();
  try {
    // advisory lock so two API containers starting together don't race
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      log(`applying migration ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)');
    c.release();
  }
}
