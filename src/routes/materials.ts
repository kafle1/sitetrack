import type { FastifyInstance } from 'fastify';
import { pool, tx } from '../db';
import { requireCompanyStore } from '../access';
import { conflict, notFound } from '../errors';
import { arr, errorBody, int, obj, ok, pageOf, pageQuery, paged, str } from '../schemas';

const material = obj({ id: int, name: str, category: str, unit: str });
const body = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  category: { type: 'string', minLength: 1, maxLength: 100 },
  unit: { type: 'string', minLength: 1, maxLength: 30 },
};

export const likePattern = (q: string) => `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;

export default async function materialRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { page: number; pageSize: number; q?: string; category?: string } }>(
    '/materials',
    {
      schema: {
        tags: ['materials'],
        summary: 'Materials catalogue (everyone logged in), sorted by name',
        querystring: {
          type: 'object',
          properties: { ...pageQuery, q: { type: 'string', maxLength: 200 }, category: { type: 'string', maxLength: 100 } },
        },
        response: { 200: paged(material) },
      },
    },
    async (req) => {
      const { q, category } = req.query;
      const { limit, offset } = pageOf(req.query);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q?.trim()) where.push(`name ILIKE $${params.push(likePattern(q))}`);
      if (category) where.push(`category = $${params.push(category)}`);
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [list, count] = await Promise.all([
        pool.query(`SELECT id, name, category, unit FROM materials ${w} ORDER BY name, id LIMIT ${limit} OFFSET ${offset}`, params),
        pool.query(`SELECT count(*)::int AS n FROM materials ${w}`, params),
      ]);
      return { items: list.rows, page: req.query.page, pageSize: req.query.pageSize, total: count.rows[0].n };
    },
  );

  app.get(
    '/materials/categories',
    { schema: { tags: ['materials'], summary: 'Every category in use, for filter dropdowns', response: { 200: arr(str) } } },
    async () => (await pool.query('SELECT DISTINCT category FROM materials ORDER BY category')).rows.map((r) => r.category),
  );

  app.get<{ Params: { id: number } }>(
    '/materials/:id',
    { schema: { tags: ['materials'], summary: 'One material', params: obj({ id: int }), response: { 200: material, 404: errorBody } } },
    async (req) => {
      const { rows } = await pool.query('SELECT id, name, category, unit FROM materials WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw notFound('Material not found');
      return rows[0];
    },
  );

  app.post<{ Body: { name: string; category: string; unit: string } }>(
    '/materials',
    {
      schema: {
        tags: ['materials'],
        summary: 'Add a material to the catalogue (company store managers and SuperAdmins)',
        body: obj(body),
        response: { 201: material, 403: errorBody },
      },
    },
    async (req, reply) => {
      requireCompanyStore(req.user);
      const row = await tx(async (c) => {
        const { rows } = await c.query('INSERT INTO materials (name, category, unit) VALUES ($1, $2, $3) RETURNING id, name, category, unit', [
          req.body.name.trim(),
          req.body.category.trim(),
          req.body.unit.trim(),
        ]);
        await c.query('INSERT INTO company_stock (material_id) VALUES ($1)', [rows[0].id]);
        return rows[0];
      });
      return reply.status(201).send(row);
    },
  );

  app.patch<{ Params: { id: number }; Body: { name?: string; category?: string; unit?: string } }>(
    '/materials/:id',
    {
      schema: {
        tags: ['materials'],
        summary: 'Edit a material (company store managers and SuperAdmins)',
        params: obj({ id: int }),
        body: { ...obj(body, []), minProperties: 1 },
        response: { 200: material, 403: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      const { name, category, unit } = req.body;
      const { rows } = await pool.query(
        `UPDATE materials SET name = coalesce($2, name), category = coalesce($3, category), unit = coalesce($4, unit)
         WHERE id = $1 RETURNING id, name, category, unit`,
        [req.params.id, name?.trim() ?? null, category?.trim() ?? null, unit?.trim() ?? null],
      );
      if (!rows[0]) throw notFound('Material not found');
      return rows[0];
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/materials/:id',
    {
      schema: {
        tags: ['materials'],
        summary: 'Remove a material (company store managers and SuperAdmins)',
        description: 'Refused with 409 once the material has any stock or delivery history.',
        params: obj({ id: int }),
        response: { 200: ok, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      await tx(async (c) => {
        const { rows } = await c.query('SELECT quantity FROM company_stock WHERE material_id = $1 FOR UPDATE', [req.params.id]);
        if (rows[0]?.quantity > 0) throw conflict('material_in_use', 'The company store still holds this material');
        await c.query('DELETE FROM company_stock WHERE material_id = $1', [req.params.id]);
        const { rowCount } = await c.query('DELETE FROM materials WHERE id = $1', [req.params.id]).catch((e) => {
          if (e.code === '23503') throw conflict('material_in_use', 'This material has stock or deliveries and cannot be removed');
          throw e;
        });
        if (!rowCount) throw notFound('Material not found');
      });
      return { ok: true };
    },
  );
}
