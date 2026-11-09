import type { FastifyInstance } from 'fastify';
import { pagedRows, pool } from '../db';
import { projectAccess, requireCompanyStore } from '../access';
import { notFound } from '../errors';
import { dateTime, errorBody, idIn, int, nullable, num, obj, pageOf, pageQuery, paged, str, strEnum } from '../schemas';
import { likePattern } from './materials';

const STOCK_STATUSES = ['out_of_stock', 'low_stock', 'available'];

const companyItem = obj({
  materialId: int,
  name: str,
  category: str,
  unit: str,
  quantity: num,
  inTransitToProjects: num,
  reorderPoint: num,
  status: strEnum(STOCK_STATUSES),
});

const projectItem = obj({ materialId: int, name: str, category: str, unit: str, quantity: num, lastDeliveryAt: nullable(dateTime) });

const COMPANY_SORTS: Record<string, string> = { name: 'name', quantity: 'quantity', status: 'status_rank' };
const PROJECT_SORTS: Record<string, string> = { name: 'name', quantity: 'quantity', lastDelivery: 'last_delivery_at' };

interface ListQuery {
  page: number;
  pageSize: number;
  q?: string;
  category?: string;
  status?: string;
  sort: string;
  order: 'asc' | 'desc';
}

const listProps = (sorts: Record<string, string>) => ({
  ...pageQuery,
  q: { type: 'string', maxLength: 200 },
  category: { type: 'string', maxLength: 100 },
  sort: { ...strEnum(Object.keys(sorts)), default: 'name' },
  order: { ...strEnum(['asc', 'desc']), default: 'asc' },
});

export default async function storeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>(
    '/company-store/stock',
    {
      schema: {
        tags: ['company store'],
        summary: 'Company store stock screen (company store managers and SuperAdmins)',
        description: 'Status: out_of_stock when quantity is 0, low_stock when at or below the reorder point, otherwise available. Sorting by status puts out_of_stock first.',
        querystring: { type: 'object', properties: { ...listProps(COMPANY_SORTS), status: strEnum(STOCK_STATUSES) } },
        response: { 200: paged(companyItem), 403: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      const { q, category, status, sort, order } = req.query;
      const { limit, offset } = pageOf(req.query);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q?.trim()) where.push(`name ILIKE $${params.push(likePattern(q))}`);
      if (category) where.push(`category = $${params.push(category)}`);
      if (status) where.push(`status_rank = $${params.push(STOCK_STATUSES.indexOf(status))}`);
      const { rows, total } = await pagedRows(
        `SELECT *, count(*) OVER () AS total_count FROM (
           SELECT m.id, m.name, m.category, m.unit, s.quantity, s.reorder_point,
             CASE WHEN s.quantity = 0 THEN 0 WHEN s.quantity <= s.reorder_point THEN 1 ELSE 2 END AS status_rank
           FROM materials m JOIN company_stock s ON s.material_id = m.id
         ) x ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ${COMPANY_SORTS[sort]} ${order === 'desc' ? 'DESC' : 'ASC'}, name, id
`,
        params,
        limit,
        offset,
      );
      // in-transit totals only for the rows on this page
      const { rows: transit } = await pool.query(
        `SELECT l.material_id, sum(l.quantity) AS qty FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
         WHERE d.status = 'in_transit' AND d.direction = 'to_project' AND l.material_id = ANY($1)
         GROUP BY l.material_id`,
        [rows.map((r) => r.id)],
      );
      const transitMap = new Map(transit.map((t) => [t.material_id, t.qty]));
      return {
        items: rows.map((r) => ({
          materialId: r.id,
          name: r.name,
          category: r.category,
          unit: r.unit,
          quantity: r.quantity,
          inTransitToProjects: transitMap.get(r.id) ?? 0,
          reorderPoint: r.reorder_point,
          status: STOCK_STATUSES[r.status_rank],
        })),
        page: req.query.page,
        pageSize: req.query.pageSize,
        total,
      };
    },
  );

  const stockRow = async (materialId: number) => {
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.category, m.unit, s.quantity, s.reorder_point FROM materials m JOIN company_stock s ON s.material_id = m.id WHERE m.id = $1`,
      [materialId],
    );
    const r = rows[0];
    return { materialId: r.id, name: r.name, unit: r.unit, quantity: r.quantity, reorderPoint: r.reorder_point };
  };
  const stockResponse = obj({ materialId: int, name: str, unit: str, quantity: num, reorderPoint: num });

  app.post<{ Params: { materialId: number }; Body: { quantity: number } }>(
    '/company-store/stock/:materialId/add',
    {
      schema: {
        tags: ['company store'],
        summary: 'Add stock that arrived from a supplier (company store managers and SuperAdmins)',
        params: obj({ materialId: idIn }),
        body: obj({ quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 } }),
        response: { 200: stockResponse, 403: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      // one statement, so it either fully applies or not at all
      const { rowCount } = await pool.query(
        `INSERT INTO company_stock (material_id, quantity) SELECT id, $2 FROM materials WHERE id = $1
         ON CONFLICT (material_id) DO UPDATE SET quantity = company_stock.quantity + EXCLUDED.quantity`,
        [req.params.materialId, req.body.quantity],
      );
      if (!rowCount) throw notFound('Material not found');
      return stockRow(req.params.materialId);
    },
  );

  app.patch<{ Params: { materialId: number }; Body: { reorderPoint: number } }>(
    '/company-store/stock/:materialId',
    {
      schema: {
        tags: ['company store'],
        summary: 'Set the reorder point for a material (company store managers and SuperAdmins)',
        params: obj({ materialId: idIn }),
        body: obj({ reorderPoint: { type: 'number', minimum: 0, maximum: 1e9 } }),
        response: { 200: stockResponse, 403: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      const { rowCount } = await pool.query(
        `INSERT INTO company_stock (material_id, reorder_point) SELECT id, $2 FROM materials WHERE id = $1
         ON CONFLICT (material_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point`,
        [req.params.materialId, req.body.reorderPoint],
      );
      if (!rowCount) throw notFound('Material not found');
      return stockRow(req.params.materialId);
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: ListQuery }>(
    '/projects/:projectId/store',
    {
      schema: {
        tags: ['project store'],
        summary: 'Project store screen: every material the store has held',
        params: obj({ projectId: { type: 'string', example: 'PRJ-0042' } }),
        querystring: { type: 'object', properties: listProps(PROJECT_SORTS) },
        response: { 200: paged(projectItem), 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      const { q, category, sort, order } = req.query;
      const { limit, offset } = pageOf(req.query);
      const params: unknown[] = [projectId];
      const where = ['s.project_id = $1'];
      if (q?.trim()) where.push(`m.name ILIKE $${params.push(likePattern(q))}`);
      if (category) where.push(`m.category = $${params.push(category)}`);
      const { rows, total } = await pagedRows(
        `SELECT m.id, m.name, m.category, m.unit, s.quantity, s.last_delivery_at, count(*) OVER () AS total_count
         FROM project_stock s JOIN materials m ON m.id = s.material_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${PROJECT_SORTS[sort]} ${order === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}, m.name, m.id
`,
        params,
        limit,
        offset,
      );
      return {
        items: rows.map((r) => ({
          materialId: r.id,
          name: r.name,
          category: r.category,
          unit: r.unit,
          quantity: r.quantity,
          lastDeliveryAt: r.last_delivery_at,
        })),
        page: req.query.page,
        pageSize: req.query.pageSize,
        total,
      };
    },
  );
}
