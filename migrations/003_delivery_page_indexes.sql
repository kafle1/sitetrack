-- include id so the newest-first page order (sent_at, id) is read straight off the index
DROP INDEX deliveries_sent_idx;
DROP INDEX deliveries_project_idx;
DROP INDEX deliveries_status_idx;
CREATE INDEX deliveries_sent_idx ON deliveries (sent_at DESC, id DESC);
CREATE INDEX deliveries_project_idx ON deliveries (project_id, sent_at DESC, id DESC);
CREATE INDEX deliveries_status_idx ON deliveries (status, sent_at DESC, id DESC);
