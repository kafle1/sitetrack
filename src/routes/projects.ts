import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../auth';
import { likePattern, pagedRows, pool, tx } from '../db';
import { projectAccess, projectAdmin } from '../access';
import { checkDates, conflict } from '../errors';
import { projectCode, searchNumber } from '../ids';
import { bool, date, errorBody, int, num, obj, ok, order, pageQuery, paged, projectIdParam, str, strEnum, text } from '../schemas';
import { blockedCountsSql, lateSql } from '../taskSql';

const projectSummary = obj({
  id: str,
  name: str,
  plannedStart: date,
  plannedEnd: date,
  isAdmin: bool,
  memberCount: int,
  taskCounts: obj({ notStarted: int, inProgress: int, done: int, total: int }),
  percentDone: num,
  lateTasks: int,
  blockedTasks: int,
});

const projectBody = {
  name: text(200),
  plannedStart: date,
  plannedEnd: date,
};

const SORTS: Record<string, string> = {
  name: 'name',
  startDate: 'planned_start',
  percentDone: 'percent_done',
  lateTasks: 'late',
};

interface ListQuery {
  page: number;
  pageSize: number;
  q?: string;
  lateOnly?: boolean;
  sort: string;
  order: 'asc' | 'desc';
}

// every project the user can access, with what the projects screen shows; $1 is the user id
function projectsSql(user: AuthUser, where: string[], lateOnly = false) {
  // superadmins see every project and act as its admin, everyone else only their memberships
  const superadmin = user.role === 'superadmin';
  const from = superadmin
    ? 'projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1'
    : 'project_members pm JOIN projects p ON p.id = pm.project_id AND pm.user_id = $1';
  return `
    WITH acc AS (
      SELECT p.id, p.name, p.planned_start, p.planned_end, p.task_total, p.task_done, ${superadmin ? 'true' : 'pm.is_admin'} AS is_admin
      FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ), open AS (
      SELECT t.project_id,
        count(*) FILTER (WHERE t.status = 'not_started') AS not_started,
        count(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
        count(*) FILTER (WHERE ${lateSql('t')}) AS late
      FROM tasks t WHERE t.status <> 'done' AND t.project_id IN (SELECT id FROM acc)
      GROUP BY t.project_id
    ), rows AS (
      SELECT acc.*, acc.task_total AS total, acc.task_done AS done, coalesce(s.not_started, 0) AS not_started,
        coalesce(s.in_progress, 0) AS in_progress, coalesce(s.late, 0) AS late,
        CASE WHEN acc.task_total = 0 THEN 0 ELSE round(acc.task_done * 100.0 / acc.task_total, 1) END AS percent_done
      FROM acc LEFT JOIN open s ON s.project_id = acc.id
      ${lateOnly ? 'WHERE coalesce(s.late, 0) > 0' : ''}
    )
    SELECT rows.*, count(*) OVER () AS total_count,
      (SELECT count(*) FROM project_members m WHERE m.project_id = rows.id) AS member_count
    FROM rows`;
}

// Blocked counts are worked out for these rows only
async function summaries(rows: any[]) {
  const { rows: blocked } = await pool.query(blockedCountsSql, [rows.map((r) => r.id)]);
  const blockedById = new Map(blocked.map((b) => [b.project_id, b.n]));
  return rows.map((r) => ({
    id: projectCode(r.id),
    name: r.name,
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    isAdmin: r.is_admin,
    memberCount: r.member_count,
    taskCounts: { notStarted: r.not_started, inProgress: r.in_progress, done: r.done, total: r.total },
    percentDone: r.percent_done,
    lateTasks: r.late,
    blockedTasks: blockedById.get(r.id) ?? 0,
  }));
}

async function projectDetail(user: AuthUser, projectId: number) {
  const { rows } = await pool.query(projectsSql(user, ['p.id = $2']), [user.id, projectId]);
  return (await summaries(rows))[0];
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Projects screen: every project I can access',
        description: 'Search matches the name or the ID (PRJ-0042, 0042 or 42). Blocked counts are worked out for the returned page only.',
        querystring: {
          type: 'object',
          properties: {
            ...pageQuery,
            q: { type: 'string', maxLength: 200 },
            lateOnly: { type: 'boolean' },
            sort: { ...strEnum(Object.keys(SORTS)), default: 'name' },
            order,
          },
        },
        response: { 200: paged(projectSummary) },
      },
    },
    async (req) => {
      const { q, lateOnly, sort, order } = req.query;
      const params: unknown[] = [req.user.id];
      const where: string[] = [];
      if (q?.trim()) where.push(`(p.name ILIKE $${params.push(likePattern(q))} OR p.id = $${params.push(searchNumber(q, /PRJ-/))})`);
      const sql = `${projectsSql(req.user, where, lateOnly)} ORDER BY ${SORTS[sort]} ${order.toUpperCase()}, id`;
      const { rows, total } = await pagedRows(sql, params, req.query);
      return { items: await summaries(rows), page: req.query.page, pageSize: req.query.pageSize, total };
    },
  );

  app.post<{ Body: { name: string; plannedStart: string; plannedEnd: string } }>(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Create a project; I become its project admin',
        body: obj(projectBody),
        response: { 201: projectSummary, 400: errorBody },
      },
    },
    async (req, reply) => {
      const { name, plannedStart, plannedEnd } = req.body;
      checkDates(plannedStart, plannedEnd);
      const id = await tx(async (c) => {
        const { rows } = await c.query(`UPDATE counters SET value = value + 1 WHERE name = 'project' RETURNING value`);
        const id = rows[0].value as number;
        await c.query(
          `INSERT INTO projects (id, name, planned_start, planned_end, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, name.trim(), plannedStart, plannedEnd, req.user.id],
        );
        await c.query(`INSERT INTO project_members (project_id, user_id, is_admin) VALUES ($1, $2, true)`, [id, req.user.id]);
        return id;
      });
      return reply.status(201).send(await projectDetail(req.user, id));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    { schema: { tags: ['projects'], summary: 'One project', params: projectIdParam(), response: { 200: projectSummary, 404: errorBody } } },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      return projectDetail(req.user, projectId);
    },
  );

  app.patch<{ Params: { projectId: string }; Body: { name?: string; plannedStart?: string; plannedEnd?: string } }>(
    '/projects/:projectId',
    {
      schema: {
        tags: ['projects'],
        summary: 'Edit a project (project admins)',
        params: projectIdParam(),
        body: { ...obj(projectBody, []), minProperties: 1 },
        response: { 200: projectSummary, 400: errorBody, 403: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      const { name, plannedStart, plannedEnd } = req.body;
      const projectId = await tx(async (c) => {
        const { projectId } = await projectAdmin(c, req.user, req.params.projectId, true);
        const { rows } = await c.query('SELECT planned_start, planned_end FROM projects WHERE id = $1', [projectId]);
        checkDates(plannedStart ?? rows[0].planned_start, plannedEnd ?? rows[0].planned_end);
        await c.query(
          `UPDATE projects SET name = coalesce($2, name), planned_start = coalesce($3, planned_start), planned_end = coalesce($4, planned_end)
           WHERE id = $1`,
          [projectId, name?.trim() ?? null, plannedStart ?? null, plannedEnd ?? null],
        );
        return projectId;
      });
      return projectDetail(req.user, projectId);
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    {
      schema: {
        tags: ['projects'],
        summary: 'Remove a project (project admins)',
        description: 'Refused with 409 while the project store holds stock or a delivery is in transit, so no material disappears.',
        params: projectIdParam(),
        response: { 200: ok, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      await tx(async (c) => {
        const { projectId } = await projectAdmin(c, req.user, req.params.projectId, true);
        const { rows } = await c.query(
          `SELECT EXISTS (SELECT 1 FROM project_stock WHERE project_id = $1 AND quantity > 0) AS stock,
                  EXISTS (SELECT 1 FROM deliveries WHERE project_id = $1 AND status = 'in_transit') AS transit`,
          [projectId],
        );
        if (rows[0].stock || rows[0].transit)
          throw conflict('project_has_stock', 'Send the project store stock back and settle in-transit deliveries first');
        await c.query('DELETE FROM projects WHERE id = $1', [projectId]);
      });
      return { ok: true };
    },
  );
}
