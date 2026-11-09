import type { PoolClient } from 'pg';
import { conflict } from './errors';

export interface Line {
  materialId: number;
  quantity: number;
}

// null means the company store, a number is that project's store
export type Store = number | null;

// takes stock out under row locks taken in material order, so concurrent senders queue instead of deadlocking
export async function takeStock(c: PoolClient, store: Store, lines: Line[]) {
  const ids = lines.map((l) => l.materialId);
  const { rows } =
    store === null
      ? await c.query('SELECT material_id, quantity FROM company_stock WHERE material_id = ANY($1) ORDER BY material_id FOR UPDATE', [ids])
      : await c.query(
          'SELECT material_id, quantity FROM project_stock WHERE project_id = $2 AND material_id = ANY($1) ORDER BY material_id FOR UPDATE',
          [ids, store],
        );
  const have = new Map(rows.map((r) => [r.material_id, r.quantity as number]));
  const short = lines.filter((l) => (have.get(l.materialId) ?? 0) < l.quantity).map((l) => l.materialId);
  if (short.length) throw conflict('insufficient_stock', `Not enough stock for material ${short.join(', ')}`);
  const qty = lines.map((l) => l.quantity);
  if (store === null)
    await c.query(
      `UPDATE company_stock s SET quantity = s.quantity - l.qty FROM unnest($1::int[], $2::numeric[]) AS l(id, qty) WHERE s.material_id = l.id`,
      [ids, qty],
    );
  else
    await c.query(
      `UPDATE project_stock s SET quantity = s.quantity - l.qty, last_delivery_at = now()
       FROM unnest($1::int[], $2::numeric[]) AS l(id, qty) WHERE s.project_id = $3 AND s.material_id = l.id`,
      [ids, qty, store],
    );
}

export async function addStock(c: PoolClient, store: Store, lines: Line[]) {
  const ids = lines.map((l) => l.materialId);
  const qty = lines.map((l) => l.quantity);
  if (store === null)
    await c.query(
      `INSERT INTO company_stock (material_id, quantity)
       SELECT id, qty FROM unnest($1::int[], $2::numeric[]) AS l(id, qty) ORDER BY id
       ON CONFLICT (material_id) DO UPDATE SET quantity = company_stock.quantity + EXCLUDED.quantity`,
      [ids, qty],
    );
  else
    await c.query(
      `INSERT INTO project_stock (project_id, material_id, quantity, last_delivery_at)
       SELECT $3, id, qty, now() FROM unnest($1::int[], $2::numeric[]) AS l(id, qty) ORDER BY id
       ON CONFLICT (project_id, material_id) DO UPDATE
       SET quantity = project_stock.quantity + EXCLUDED.quantity, last_delivery_at = now()`,
      [ids, qty, store],
    );
}
