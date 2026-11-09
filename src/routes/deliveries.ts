import type { FastifyInstance } from 'fastify';
import { pagedRows, pool, tx } from '../db';
import { canUseCompanyStore, projectAccess, requireCompanyStore } from '../access';
import type { AuthUser } from '../auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { parseProjectId, projectCode, searchNumber } from '../ids';
import { arr, date, dateTime, errorBody, idIn, int, nullable, num, obj, pageOf, pageQuery, paged, str, strEnum, userRef } from '../schemas';
import { addStock, takeStock, type Line } from '../stock';
import { likePattern } from './materials';

const DIRECTIONS = ['to_project', 'to_company'];
const STATUSES = ['in_transit', 'delivered', 'rejected', 'cancelled'];

const delivery = obj({
  id: int,
  project: obj({ id: str, name: str }),
  direction: strEnum(DIRECTIONS),
  status: strEnum(STATUSES),
  lines: arr(obj({ materialId: int, name: str, unit: str, quantity: num })),
  note: nullable(str),
  sentAt: dateTime,
  sentBy: userRef,
  receivedAt: nullable(dateTime),
  receivedBy: userRef,
  cancelledAt: nullable(dateTime),
  cancelledBy: userRef,
});

const linesBody = {
  type: 'array',
  minItems: 1,
  maxItems: 200,
  items: obj({ materialId: idIn, quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 } }),
};

interface ListQuery {
  page: number;
  pageSize: number;
  projectId?: string;
  direction?: string;
  status?: string;
  from?: string;
  to?: string;
}

const filterProps = {
  ...pageQuery,
  direction: strEnum(DIRECTIONS),
  status: strEnum(STATUSES),
  from: { ...date, description: 'sent on or after this day' },
  to: { ...date, description: 'sent on or before this day' },
};

function checkLines(lines: Line[]) {
  if (new Set(lines.map((l) => l.materialId)).size !== lines.length) throw badRequest('Each material can appear only once in a delivery');
  return [...lines].sort((a, b) => a.materialId - b.materialId);
}

// lines and names are fetched only for the rows on the page
async function shape(rows: any[]) {
  const ids = rows.map((r) => r.id);
  const { rows: lines } = await pool.query(
    `SELECT l.delivery_id, json_agg(json_build_object('materialId', m.id, 'name', m.name, 'unit', m.unit, 'quantity', l.quantity) ORDER BY m.name) AS lines
     FROM delivery_lines l JOIN materials m ON m.id = l.material_id WHERE l.delivery_id = ANY($1) GROUP BY l.delivery_id`,
    [ids],
  );
  const lineMap = new Map(lines.map((l) => [l.delivery_id, l.lines]));
  const ref = (id: number | null, name: string | null) => (id ? { id, name: name! } : null);
  return rows.map((r) => ({
    id: r.id,
    project: { id: projectCode(r.project_id), name: r.project_name },
    direction: r.direction,
    status: r.status,
    lines: (lineMap.get(r.id) ?? []).map((l: any) => ({ ...l, quantity: Number(l.quantity) })),
    note: r.note,
    sentAt: r.sent_at,
    sentBy: ref(r.sent_by, r.sent_by_name),
    receivedAt: r.received_at,
    receivedBy: ref(r.received_by, r.received_by_name),
    cancelledAt: r.cancelled_at,
    cancelledBy: ref(r.cancelled_by, r.cancelled_by_name),
  }));
}

const SELECT = `
  SELECT d.*, p.name AS project_name, s.name AS sent_by_name, r.name AS received_by_name, x.name AS cancelled_by_name
  FROM deliveries d JOIN projects p ON p.id = d.project_id
  LEFT JOIN users s ON s.id = d.sent_by LEFT JOIN users r ON r.id = d.received_by LEFT JOIN users x ON x.id = d.cancelled_by`;

async function list(q: ListQuery, projectId: number | null) {
  const { limit, offset } = pageOf(q);
  const params: unknown[] = [];
  const where: string[] = [];
  if (projectId !== null) where.push(`d.project_id = $${params.push(projectId)}`);
  if (q.direction) where.push(`d.direction = $${params.push(q.direction)}::delivery_direction`);
  if (q.status) where.push(`d.status = $${params.push(q.status)}::delivery_status`);
  if (q.from) where.push(`d.sent_at >= $${params.push(q.from)}::date`);
  if (q.to) where.push(`d.sent_at < $${params.push(q.to)}::date + 1`);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // pick the page's ids on the index first, so deep pages skip rows without joining names onto them
  const [page, count] = await Promise.all([
    pool.query(
      `${SELECT} WHERE d.id IN (SELECT d.id FROM deliveries d ${w} ORDER BY d.sent_at DESC, d.id DESC LIMIT ${limit} OFFSET ${offset})
       ORDER BY d.sent_at DESC, d.id DESC`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n FROM deliveries d ${w}`, params),
  ]);
  return { items: await shape(page.rows), page: q.page, pageSize: q.pageSize, total: count.rows[0].n };
}

async function loadOne(id: number) {
  const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
  return (await shape(rows))[0];
}

// a delivery is visible to the company store side and to members of its project
async function visibleDelivery(user: AuthUser, id: number) {
  const { rows } = await pool.query('SELECT id, project_id, direction, status FROM deliveries WHERE id = $1', [id]);
  const d = rows[0];
  if (!d) throw notFound('Delivery not found');
  let member = false;
  try {
    await projectAccess(pool, user, projectCode(d.project_id));
    member = true;
  } catch {}
  if (!member && !canUseCompanyStore(user)) throw notFound('Delivery not found');
  return { ...d, member };
}

export default async function deliveryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>(
    '/company-store/deliveries',
    {
      schema: {
        tags: ['company store'],
        summary: 'Company store deliveries screen, newest first (company store managers and SuperAdmins)',
        querystring: { type: 'object', properties: { ...filterProps, projectId: { type: 'string', example: 'PRJ-0042' } } },
        response: { 200: paged(delivery), 403: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      let projectId: number | null = null;
      if (req.query.projectId) {
        projectId = parseProjectId(req.query.projectId);
        if (projectId === null) throw badRequest('projectId looks like PRJ-0042');
      }
      return list(req.query, projectId);
    },
  );

  app.get<{ Querystring: { q?: string; page: number; pageSize: number } }>(
    '/company-store/projects',
    {
      schema: {
        tags: ['company store'],
        summary: 'Project picker for the company store: ID and name of every project (company store managers and SuperAdmins)',
        querystring: { type: 'object', properties: { ...pageQuery, q: { type: 'string', maxLength: 200 } } },
        response: { 200: paged(obj({ id: str, name: str })), 403: errorBody },
      },
    },
    async (req) => {
      requireCompanyStore(req.user);
      const { limit, offset } = pageOf(req.query);
      const params: unknown[] = [];
      let w = '';
      if (req.query.q?.trim()) {
        w = `WHERE name ILIKE $1 OR id = $2`;
        params.push(likePattern(req.query.q), searchNumber(req.query.q, /PRJ-/));
      }
      const { rows, total } = await pagedRows(
        `SELECT id, name, count(*) OVER () AS total_count FROM projects ${w} ORDER BY name, id`,
        params,
        limit,
        offset,
      );
      return { items: rows.map((r) => ({ id: projectCode(r.id), name: r.name })), page: req.query.page, pageSize: req.query.pageSize, total };
    },
  );

  app.post<{ Body: { projectId: string; lines: Line[]; note?: string } }>(
    '/company-store/deliveries',
    {
      schema: {
        tags: ['company store'],
        summary: 'Send materials from the company store to a project store (company store managers and SuperAdmins)',
        description: 'The quantities leave company stock at once and the delivery is in_transit. 409 insufficient_stock when any line is short; nothing moves then.',
        body: obj({ projectId: { type: 'string', example: 'PRJ-0042' }, lines: linesBody, note: { type: 'string', maxLength: 1000 } }, ['projectId', 'lines']),
        response: { 201: delivery, 400: errorBody, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req, reply) => {
      requireCompanyStore(req.user);
      const projectId = parseProjectId(req.body.projectId);
      if (projectId === null) throw notFound('Project not found');
      const lines = checkLines(req.body.lines);
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO deliveries (project_id, direction, sent_by, note) SELECT id, 'to_project', $2, $3 FROM projects WHERE id = $1 RETURNING id`,
          [projectId, req.user.id, req.body.note ?? null],
        );
        if (!rows[0]) throw notFound('Project not found');
        await takeStock(c, null, lines);
        await insertLines(c, rows[0].id, lines);
        return rows[0].id as number;
      });
      return reply.status(201).send(await loadOne(id));
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: ListQuery }>(
    '/projects/:projectId/deliveries',
    {
      schema: {
        tags: ['project store'],
        summary: 'Project deliveries screen: incoming and outgoing, newest first',
        params: obj({ projectId: { type: 'string', example: 'PRJ-0042' } }),
        querystring: { type: 'object', properties: filterProps },
        response: { 200: paged(delivery), 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      return list(req.query, projectId);
    },
  );

  app.post<{ Params: { projectId: string }; Body: { lines: Line[]; note?: string } }>(
    '/projects/:projectId/deliveries',
    {
      schema: {
        tags: ['project store'],
        summary: 'Send materials from this project store back to the company store (project members)',
        description: 'Project stores never deliver to each other; the receiver is always the company store.',
        params: obj({ projectId: { type: 'string', example: 'PRJ-0042' } }),
        body: obj({ lines: linesBody, note: { type: 'string', maxLength: 1000 } }, ['lines']),
        response: { 201: delivery, 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req, reply) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      const lines = checkLines(req.body.lines);
      const id = await tx(async (c) => {
        await takeStock(c, projectId, lines);
        const { rows } = await c.query(
          `INSERT INTO deliveries (project_id, direction, sent_by, note) VALUES ($1, 'to_company', $2, $3) RETURNING id`,
          [projectId, req.user.id, req.body.note ?? null],
        );
        await insertLines(c, rows[0].id, lines);
        return rows[0].id as number;
      });
      return reply.status(201).send(await loadOne(id));
    },
  );

  app.get<{ Params: { id: number } }>(
    '/deliveries/:id',
    {
      schema: { tags: ['deliveries'], summary: 'One delivery', params: obj({ id: idIn }), response: { 200: delivery, 404: errorBody } },
    },
    async (req) => {
      await visibleDelivery(req.user, req.params.id);
      return loadOne(req.params.id);
    },
  );

  const actions = {
    record: { status: 'delivered', who: 'receiver', summary: 'Record an arrived delivery: the quantities join the receiving store' },
    reject: { status: 'rejected', who: 'receiver', summary: 'Reject an arrived delivery: the quantities go back to the sender' },
    cancel: { status: 'cancelled', who: 'sender', summary: 'Cancel a delivery still in transit: the quantities go back to the sender' },
  } as const;

  for (const [action, a] of Object.entries(actions)) {
    app.post<{ Params: { id: number } }>(
      `/deliveries/:id/${action}`,
      {
        schema: {
          tags: ['deliveries'],
          summary: a.summary,
          description:
            'The receiver of a to_project delivery is the project (any member); of a to_company delivery, the company store. ' +
            'The sender is the other side. 409 when the delivery is no longer in transit.',
          params: obj({ id: idIn }),
          response: { 200: delivery, 403: errorBody, 404: errorBody, 409: errorBody },
        },
      },
      async (req) => {
        const d = await visibleDelivery(req.user, req.params.id);
        const projectSide = (d.direction === 'to_project') === (a.who === 'receiver');
        if (projectSide && !d.member) throw forbidden('Only members of this project can do this');
        if (!projectSide) requireCompanyStore(req.user);
        await tx(async (c) => {
          // the row lock plus the status check means two people answering at once can't both move stock
          const { rows } = await c.query('SELECT status FROM deliveries WHERE id = $1 FOR UPDATE', [d.id]);
          if (rows[0].status !== 'in_transit') throw conflict('not_in_transit', `This delivery is already ${rows[0].status}`);
          const { rows: lines } = await c.query(
            'SELECT material_id AS "materialId", quantity FROM delivery_lines WHERE delivery_id = $1 ORDER BY material_id',
            [d.id],
          );
          const projectStore = d.project_id as number;
          const receiver = d.direction === 'to_project' ? projectStore : null;
          const sender = d.direction === 'to_project' ? null : projectStore;
          await addStock(c, action === 'record' ? receiver : sender, lines);
          const cols = action === 'cancel' ? 'cancelled_by = $3, cancelled_at = now()' : 'received_by = $3, received_at = now()';
          await c.query(`UPDATE deliveries SET status = $2, ${cols} WHERE id = $1`, [d.id, a.status, req.user.id]);
        });
        return loadOne(d.id);
      },
    );
  }
}

async function insertLines(c: { query: (q: string, p: unknown[]) => Promise<unknown> }, deliveryId: number, lines: Line[]) {
  await c.query(
    `INSERT INTO delivery_lines (delivery_id, material_id, quantity) SELECT $1, id, qty FROM unnest($2::int[], $3::numeric[]) AS l(id, qty)`,
    [deliveryId, lines.map((l) => l.materialId), lines.map((l) => l.quantity)],
  );
}
