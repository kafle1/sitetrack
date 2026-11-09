import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { likePattern, pagedRows, pool, tx, type Db } from '../db';
import { projectAccess } from '../access';
import type { AuthUser } from '../auth';
import { checkDates, conflict, notFound } from '../errors';
import { parseTaskNumber, searchNumber, taskCode } from '../ids';
import { arr, bool, date, errorBody, int, obj, ok, order, pageQuery, paged, projectIdParam, str, strEnum, text } from '../schemas';
import { lateSql, notDoneUpstreamSql, startedDownstreamSql, waitingCte, wouldCycleSql } from '../taskSql';

const STATUSES = ['not_started', 'in_progress', 'done'];
const ACTIONS = ['start', 'done', 'reopen'];
const MOVES: Record<string, [string, string]> = { start: ['not_started', 'in_progress'], done: ['in_progress', 'done'], reopen: ['done', 'in_progress'] };

const taskParams = projectIdParam({ taskId: { type: 'string', example: 'PRJ-0042-T-0137' } });

const taskItem = obj({
  id: str,
  name: str,
  plannedStart: date,
  plannedEnd: date,
  status: strEnum(STATUSES),
  late: bool,
  blocked: bool,
  dependsOn: arr(str),
  dependentCount: int,
});

const relatedTask = obj({ id: str, name: str, status: strEnum(STATUSES), late: bool, steps: int });

const taskDetail = obj({
  id: str,
  name: str,
  plannedStart: date,
  plannedEnd: date,
  status: strEnum(STATUSES),
  late: bool,
  blocked: bool,
  allowedActions: arr(strEnum(ACTIONS)),
  waitsOn: arr(relatedTask),
  waitedOnBy: arr(relatedTask),
});

const SORTS: Record<string, string> = {
  id: 'number',
  name: 'name',
  startDate: 'planned_start',
  endDate: 'planned_end',
  dependents: 'dependent_count',
};

interface ListQuery {
  page: number;
  pageSize: number;
  q?: string;
  status?: string;
  late?: boolean;
  blocked?: boolean;
  from?: string;
  to?: string;
  sort: string;
  order: 'asc' | 'desc';
}

type TaskParams = { projectId: string; taskId: string };

async function findTask(db: Db, projectId: number, taskParam: string) {
  const n = parseTaskNumber(taskParam, projectId);
  if (n === null) throw notFound('Task not found');
  const { rows } = await db.query(
    `SELECT t.id, t.number, t.name, t.planned_start, t.planned_end, t.status, ${lateSql('t')} AS late
     FROM tasks t WHERE t.project_id = $1 AND t.number = $2`,
    [projectId, n],
  );
  if (!rows[0]) throw notFound('Task not found');
  return rows[0];
}

// breadth-first walk over the project's edges in memory, which gives the smallest step count per task
function walk(edges: Map<number, number[]>, start: number) {
  const steps = new Map<number, number>();
  let frontier = [start];
  for (let depth = 1; frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier)
      for (const n of edges.get(id) ?? [])
        if (n !== start && !steps.has(n)) {
          steps.set(n, depth);
          next.push(n);
        }
    frontier = next;
  }
  return steps;
}

async function loadTaskDetail(projectId: number, taskParam: string) {
  const task = await findTask(pool, projectId, taskParam);
  const { rows: edges } = await pool.query('SELECT task_id, depends_on_id FROM task_dependencies WHERE project_id = $1', [projectId]);
  const up = new Map<number, number[]>();
  const down = new Map<number, number[]>();
  for (const e of edges) {
    (up.get(e.task_id) ?? up.set(e.task_id, []).get(e.task_id)!).push(e.depends_on_id);
    (down.get(e.depends_on_id) ?? down.set(e.depends_on_id, []).get(e.depends_on_id)!).push(e.task_id);
  }
  const upSteps = walk(up, task.id);
  const downSteps = walk(down, task.id);
  const ids = [...upSteps.keys(), ...downSteps.keys()];
  const { rows } = await pool.query(
    `SELECT t.id, t.number, t.name, t.status, ${lateSql('t')} AS late FROM tasks t WHERE t.id = ANY($1)`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const related = (steps: Map<number, number>) =>
    // a task removed since the edges were read drops out instead of breaking the page
    [...steps.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, s]) => {
        const r = byId.get(id);
        return { id: taskCode(projectId, r.number), name: r.name, status: r.status, late: r.late, steps: s, number: r.number };
      })
      .sort((a, b) => a.steps - b.steps || a.number - b.number);
  const waitsOn = related(upSteps);
  const waitedOnBy = related(downSteps);
  const upstreamOpen = waitsOn.some((t) => t.status !== 'done');
  const allowedActions: string[] = [];
  if (task.status === 'not_started' && !upstreamOpen) allowedActions.push('start');
  if (task.status === 'in_progress') allowedActions.push('done');
  if (task.status === 'done' && waitedOnBy.every((t) => t.status === 'not_started')) allowedActions.push('reopen');
  return {
    id: taskCode(projectId, task.number),
    name: task.name,
    plannedStart: task.planned_start,
    plannedEnd: task.planned_end,
    status: task.status,
    late: task.late,
    blocked: task.status !== 'done' && upstreamOpen,
    allowedActions,
    waitsOn,
    waitedOnBy,
  };
}

export default async function taskRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string }; Querystring: ListQuery }>(
    '/projects/:projectId/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Project tasks screen',
        description:
          'from/to keep tasks whose planned period overlaps that range. q matches the name or the ID (PRJ-0042-T-0137, T-0137 or 137).',
        params: projectIdParam(),
        querystring: {
          type: 'object',
          properties: {
            ...pageQuery,
            q: { type: 'string', maxLength: 200 },
            status: strEnum(STATUSES),
            late: { type: 'boolean' },
            blocked: { type: 'boolean' },
            from: date,
            to: date,
            sort: { ...strEnum(Object.keys(SORTS)), default: 'id' },
            order,
          },
        },
        response: { 200: paged(taskItem), 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      const { q, status, late, blocked, from, to, sort, order } = req.query;
      const params: unknown[] = [projectId];
      const where: string[] = [];
      if (q?.trim()) {
        const n = searchNumber(q, new RegExp(`PRJ-0*${projectId}-T-|T-`));
        where.push(`(name ILIKE $${params.push(likePattern(q))} OR number = $${params.push(n)})`);
      }
      if (status) where.push(`status = $${params.push(status)}::task_status`);
      if (late !== undefined) where.push(late ? 'late' : 'NOT late');
      if (blocked !== undefined) where.push(blocked ? 'blocked' : 'NOT blocked');
      if (from) where.push(`planned_end >= $${params.push(from)}::date`);
      if (to) where.push(`planned_start <= $${params.push(to)}::date`);
      const sql = `
        WITH RECURSIVE ${waitingCte('u.project_id = $1')},
        dependents AS (
          SELECT depends_on_id AS id, count(*)::int AS n FROM task_dependencies WHERE project_id = $1 GROUP BY depends_on_id
        ), rows AS (
          SELECT t.id, t.number, t.name, t.planned_start, t.planned_end, t.status,
            ${lateSql('t')} AS late,
            (t.status <> 'done' AND t.id IN (SELECT id FROM waiting)) AS blocked,
            coalesce(dc.n, 0) AS dependent_count
          FROM tasks t LEFT JOIN dependents dc ON dc.id = t.id
          WHERE t.project_id = $1
        )
        SELECT *, count(*) OVER () AS total_count FROM rows
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${SORTS[sort]} ${order.toUpperCase()}, number`;
      const { rows, total } = await pagedRows(sql, params, req.query);
      const { rows: deps } = await pool.query(
        `SELECT d.task_id, array_agg(u.number ORDER BY u.number) AS numbers
         FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_id
         WHERE d.task_id = ANY($1) GROUP BY d.task_id`,
        [rows.map((r) => r.id)],
      );
      const depMap = new Map(deps.map((d) => [d.task_id, d.numbers as number[]]));
      return {
        items: rows.map((r) => ({
          id: taskCode(projectId, r.number),
          name: r.name,
          plannedStart: r.planned_start,
          plannedEnd: r.planned_end,
          status: r.status,
          late: r.late,
          blocked: r.blocked,
          dependsOn: (depMap.get(r.id) ?? []).map((n) => taskCode(projectId, n)),
          dependentCount: r.dependent_count,
        })),
        page: req.query.page,
        pageSize: req.query.pageSize,
        total,
      };
    },
  );

  app.post<{ Params: { projectId: string }; Body: { name: string; plannedStart: string; plannedEnd: string } }>(
    '/projects/:projectId/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Create a task; it starts as not_started',
        params: projectIdParam(),
        body: obj({ name: text(300), plannedStart: date, plannedEnd: date }),
        response: { 201: taskDetail, 400: errorBody, 404: errorBody },
      },
    },
    async (req, reply) => {
      const { name, plannedStart, plannedEnd } = req.body;
      checkDates(plannedStart, plannedEnd);
      const { projectId, number } = await tx(async (c) => {
        const { projectId } = await projectAccess(c, req.user, req.params.projectId, true);
        const { rows } = await c.query('UPDATE projects SET task_counter = task_counter + 1, task_total = task_total + 1 WHERE id = $1 RETURNING task_counter', [projectId]);
        await c.query(
          'INSERT INTO tasks (project_id, number, name, planned_start, planned_end) VALUES ($1, $2, $3, $4, $5)',
          [projectId, rows[0].task_counter, name.trim(), plannedStart, plannedEnd],
        );
        return { projectId, number: rows[0].task_counter as number };
      });
      return reply.status(201).send(await loadTaskDetail(projectId, taskCode(projectId, number)));
    },
  );

  app.get<{ Params: TaskParams }>(
    '/projects/:projectId/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Task details: allowed actions plus every task it waits on and that waits on it, with step counts',
        params: taskParams,
        response: { 200: taskDetail, 404: errorBody },
      },
    },
    async (req) => {
      const { projectId } = await projectAccess(pool, req.user, req.params.projectId);
      return loadTaskDetail(projectId, req.params.taskId);
    },
  );

  app.patch<{ Params: TaskParams; Body: { name?: string; plannedStart?: string; plannedEnd?: string } }>(
    '/projects/:projectId/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Edit a task name or dates (status changes go through the action routes)',
        params: taskParams,
        body: { ...obj({ name: text(300), plannedStart: date, plannedEnd: date }, []), minProperties: 1 },
        response: { 200: taskDetail, 400: errorBody, 404: errorBody },
      },
    },
    async (req) => {
      const projectId = await tx(async (c) => {
        const { projectId } = await projectAccess(c, req.user, req.params.projectId, true);
        const task = await findTask(c, projectId, req.params.taskId);
        const { name, plannedStart, plannedEnd } = req.body;
        checkDates(plannedStart ?? task.planned_start, plannedEnd ?? task.planned_end);
        await c.query(
          `UPDATE tasks SET name = coalesce($2, name), planned_start = coalesce($3, planned_start), planned_end = coalesce($4, planned_end)
           WHERE id = $1`,
          [task.id, name?.trim() ?? null, plannedStart ?? null, plannedEnd ?? null],
        );
        return projectId;
      });
      return loadTaskDetail(projectId, req.params.taskId);
    },
  );

  app.delete<{ Params: TaskParams }>(
    '/projects/:projectId/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Remove a task and its dependency links. Its ID is never handed out again.',
        params: taskParams,
        response: { 200: ok, 404: errorBody },
      },
    },
    async (req) => {
      await tx(async (c) => {
        const { projectId } = await projectAccess(c, req.user, req.params.projectId, true);
        const task = await findTask(c, projectId, req.params.taskId);
        await c.query('DELETE FROM tasks WHERE id = $1', [task.id]);
        await c.query('UPDATE projects SET task_total = task_total - 1, task_done = task_done - $2 WHERE id = $1', [
          projectId,
          task.status === 'done' ? 1 : 0,
        ]);
      });
      return { ok: true };
    },
  );

  // status actions; all of them hold the project lock so a start and a reopen next door can't both pass their checks
  const transition = async (c: PoolClient, user: AuthUser, params: TaskParams, action: string) => {
    const { projectId } = await projectAccess(c, user, params.projectId, true);
    const task = await findTask(c, projectId, params.taskId);
    const [from, to] = MOVES[action];
    if (task.status !== from) throw conflict('invalid_transition', `Cannot ${action} a task that is ${task.status}`);
    if (action === 'start' && (await c.query(notDoneUpstreamSql, [task.id])).rows[0].n > 0)
      throw conflict('blocked', 'Every task this one waits on must be done first');
    if (action === 'reopen' && (await c.query(startedDownstreamSql, [task.id])).rows[0].n > 0)
      throw conflict('dependents_started', 'A task that waits on this one has already started');
    await c.query('UPDATE tasks SET status = $2 WHERE id = $1', [task.id, to]);
    if (action !== 'start') await c.query('UPDATE projects SET task_done = task_done + $2 WHERE id = $1', [projectId, action === 'done' ? 1 : -1]);
    return projectId;
  };

  for (const action of ACTIONS) {
    app.post<{ Params: TaskParams }>(
      `/projects/:projectId/tasks/:taskId/${action}`,
      {
        schema: {
          tags: ['tasks'],
          summary: {
            start: 'Start: not_started to in_progress, only when every task it waits on is done',
            done: 'Mark as done: in_progress to done',
            reopen: 'Reopen: done to in_progress, only while no task that waits on it has started',
          }[action],
          params: taskParams,
          response: { 200: taskDetail, 404: errorBody, 409: errorBody },
        },
      },
      async (req) => {
        const projectId = await tx((c) => transition(c, req.user, req.params, action));
        return loadTaskDetail(projectId, req.params.taskId);
      },
    );
  }

  app.post<{ Params: TaskParams; Body: { dependsOn: string } }>(
    '/projects/:projectId/tasks/:taskId/dependencies',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Make this task wait on another task in the same project',
        description: 'Rejected with 409 when it would make a task wait on itself, directly or through other tasks.',
        params: taskParams,
        body: obj({ dependsOn: { type: 'string', example: 'PRJ-0042-T-0136' } }),
        response: { 200: taskDetail, 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      const projectId = await tx(async (c) => {
        // one lock per project so two inserts that each look safe can't together make a loop
        const { projectId } = await projectAccess(c, req.user, req.params.projectId, true);
        const task = await findTask(c, projectId, req.params.taskId);
        const upstream = await findTask(c, projectId, req.body.dependsOn);
        if (task.id === upstream.id) throw conflict('cycle', 'A task cannot wait on itself');
        const { rows } = await c.query(wouldCycleSql, [task.id, upstream.id]);
        if (rows[0].cycle) throw conflict('cycle', 'That dependency would make a task wait on itself');
        await c.query(
          'INSERT INTO task_dependencies (project_id, task_id, depends_on_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [projectId, task.id, upstream.id],
        );
        return projectId;
      });
      return loadTaskDetail(projectId, req.params.taskId);
    },
  );

  app.delete<{ Params: TaskParams & { dependsOnId: string } }>(
    '/projects/:projectId/tasks/:taskId/dependencies/:dependsOnId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Stop this task waiting on another task',
        params: projectIdParam({ taskId: str, dependsOnId: { type: 'string', example: 'PRJ-0042-T-0136' } }),
        response: { 200: taskDetail, 404: errorBody },
      },
    },
    async (req) => {
      const projectId = await tx(async (c) => {
        const { projectId } = await projectAccess(c, req.user, req.params.projectId, true);
        const task = await findTask(c, projectId, req.params.taskId);
        const upstream = await findTask(c, projectId, req.params.dependsOnId);
        const { rowCount } = await c.query('DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2', [task.id, upstream.id]);
        if (!rowCount) throw notFound('Dependency not found');
        return projectId;
      });
      return loadTaskDetail(projectId, req.params.taskId);
    },
  );
}
