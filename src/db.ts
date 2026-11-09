import pg from 'pg';

// keep DATE as the plain 'YYYY-MM-DD' string so no timezone shifts it
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE ?? 20),
});

// an idle connection dropped by a database restart must not crash the API
pool.on('error', (e) => console.error('idle database connection error', e.message));

export type Db = pg.Pool | pg.PoolClient;

export type PageQuery = { page: number; pageSize: number };

export function pageOf(q: PageQuery) {
  return { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}

export const likePattern = (q: string) => `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;

// for list queries that select count(*) OVER () AS total_count; a page past the end asks once more for the total
export async function pagedRows(sql: string, params: unknown[], q: PageQuery) {
  const { limit, offset } = pageOf(q);
  const { rows } = await pool.query(`${sql} LIMIT ${limit} OFFSET ${offset}`, params);
  if (rows.length || !offset) return { rows, total: rows.length ? (rows[0].total_count as number) : 0 };
  const again = await pool.query(`${sql} LIMIT 1`, params);
  return { rows, total: (again.rows[0]?.total_count as number) ?? 0 };
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
