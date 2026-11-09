-- found with EXPLAIN ANALYZE on the seeded data; see the README for the numbers

-- running totals so the projects screen does not count every task of every project on each request.
-- They change in the same transaction as the task, under the project row lock.
ALTER TABLE projects ADD COLUMN task_total integer NOT NULL DEFAULT 0, ADD COLUMN task_done integer NOT NULL DEFAULT 0;
UPDATE projects p SET task_total = s.total, task_done = s.done
FROM (SELECT project_id, count(*) AS total, count(*) FILTER (WHERE status = 'done') AS done FROM tasks GROUP BY project_id) s
WHERE s.project_id = p.id;

-- not-done tasks are a small share once a company has run for years. This covers the late and
-- status counts on the projects screen and the starting set of the Blocked walk.
CREATE INDEX tasks_open_idx ON tasks (project_id, status, planned_start, planned_end, id) WHERE status <> 'done';
DROP INDEX tasks_project_stats_idx;
