// Late and Blocked are never stored; they are worked out from today's date and the graph on every read

export const LATE_SQL = (t: string) =>
  `(${t}.status <> 'done' AND (${t}.planned_end < current_date OR (${t}.status = 'not_started' AND ${t}.planned_start < current_date)))`;

// "waiting": every task downstream of a not-done task. A task is Blocked when it is not done and in this set.
// Starting from not-done tasks (not from direct deps) matters: a Done task can still sit on a not-done upstream.
export const waitingCte = (projectFilter: string) => `
  waiting(id) AS (
    SELECT d.task_id FROM tasks u JOIN task_dependencies d ON d.depends_on_id = u.id
    WHERE ${projectFilter} AND u.status <> 'done'
    UNION
    -- OFFSET 0 keeps this a per-row index lookup; the planner otherwise guesses big and scans all 1M links each step
    SELECT x.task_id FROM waiting w
    CROSS JOIN LATERAL (SELECT d.task_id FROM task_dependencies d WHERE d.depends_on_id = w.id OFFSET 0) x
  )`;

export const blockedCountsSql = `
  WITH RECURSIVE ${waitingCte('u.project_id = ANY($1)')}
  SELECT t.project_id, count(*)::int AS n FROM tasks t
  WHERE t.project_id = ANY($1) AND t.status <> 'done' AND t.id IN (SELECT id FROM waiting)
  GROUP BY t.project_id`;

// every task this one waits on, directly or not, that is still not done
export const notDoneUpstreamSql = `
  WITH RECURSIVE up(id) AS (
    SELECT depends_on_id FROM task_dependencies WHERE task_id = $1
    UNION
    SELECT d.depends_on_id FROM up JOIN task_dependencies d ON d.task_id = up.id
  )
  SELECT count(*)::int AS n FROM up JOIN tasks t ON t.id = up.id WHERE t.status <> 'done'`;

// every task that waits on this one and has already started
export const startedDownstreamSql = `
  WITH RECURSIVE down(id) AS (
    SELECT task_id FROM task_dependencies WHERE depends_on_id = $1
    UNION
    SELECT d.task_id FROM down JOIN task_dependencies d ON d.depends_on_id = down.id
  )
  SELECT count(*)::int AS n FROM down JOIN tasks t ON t.id = down.id WHERE t.status <> 'not_started'`;

// true when $2 already waits on $1, so "$1 depends on $2" would close a loop
export const wouldCycleSql = `
  WITH RECURSIVE up(id) AS (
    SELECT $2::bigint
    UNION
    SELECT d.depends_on_id FROM up JOIN task_dependencies d ON d.task_id = up.id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = $1) AS cycle`;
