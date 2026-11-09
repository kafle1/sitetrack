CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE app_role AS ENUM ('user', 'store_manager', 'superadmin');
CREATE TYPE task_status AS ENUM ('not_started', 'in_progress', 'done');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
CREATE TYPE delivery_direction AS ENUM ('to_project', 'to_company');
CREATE TYPE delivery_status AS ENUM ('in_transit', 'delivered', 'rejected', 'cancelled');

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          app_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- single row per counter; bumped with UPDATE ... RETURNING so numbers are never reused
CREATE TABLE counters (
  name  text PRIMARY KEY,
  value integer NOT NULL
);
INSERT INTO counters VALUES ('project', 0);

-- the project number is the primary key, PRJ-0042 is just how it is printed
CREATE TABLE projects (
  id            integer PRIMARY KEY,
  name          text NOT NULL,
  planned_start date NOT NULL,
  planned_end   date NOT NULL,
  task_counter  integer NOT NULL DEFAULT 0,
  created_by    bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end >= planned_start)
);

CREATE TABLE project_members (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin   boolean NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id, project_id);

CREATE TABLE invitations (
  id          bigserial PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by  bigint REFERENCES users(id) ON DELETE SET NULL,
  status      invitation_status NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  read_at     timestamptz
);
CREATE UNIQUE INDEX invitations_one_pending ON invitations (project_id, user_id) WHERE status = 'pending';
CREATE INDEX invitations_user_idx ON invitations (user_id, created_at DESC);
CREATE INDEX invitations_unread_idx ON invitations (user_id) WHERE read_at IS NULL AND status <> 'withdrawn';

CREATE TABLE tasks (
  id            bigserial PRIMARY KEY,
  project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        integer NOT NULL,
  name          text NOT NULL,
  planned_start date NOT NULL,
  planned_end   date NOT NULL,
  status        task_status NOT NULL DEFAULT 'not_started',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end >= planned_start),
  UNIQUE (project_id, number),
  UNIQUE (project_id, id)
);
-- covering index so the projects screen can count statuses and late tasks without touching the heap
CREATE INDEX tasks_project_stats_idx ON tasks (project_id, status, planned_start, planned_end);

-- project_id is repeated here so the foreign keys force both tasks into the same project
CREATE TABLE task_dependencies (
  project_id    integer NOT NULL,
  task_id       bigint NOT NULL,
  depends_on_id bigint NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, depends_on_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX task_dependencies_upstream_idx ON task_dependencies (depends_on_id, task_id);
CREATE INDEX task_dependencies_project_idx ON task_dependencies (project_id);

CREATE TABLE materials (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  category   text NOT NULL,
  unit       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX materials_name_trgm ON materials USING gin (name gin_trgm_ops);
CREATE INDEX materials_category_idx ON materials (category);

CREATE TABLE company_stock (
  material_id   integer PRIMARY KEY REFERENCES materials(id) ON DELETE RESTRICT,
  quantity      numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_point numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0)
);

CREATE TABLE project_stock (
  project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id      integer NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  quantity         numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  last_delivery_at timestamptz,
  PRIMARY KEY (project_id, material_id)
);
CREATE INDEX project_stock_material_idx ON project_stock (material_id);

CREATE TABLE deliveries (
  id          bigserial PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction   delivery_direction NOT NULL,
  status      delivery_status NOT NULL DEFAULT 'in_transit',
  sent_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  received_by bigint REFERENCES users(id) ON DELETE SET NULL,
  received_at timestamptz,
  cancelled_by bigint REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  note        text
);
CREATE INDEX deliveries_project_idx ON deliveries (project_id, sent_at DESC);
CREATE INDEX deliveries_sent_idx ON deliveries (sent_at DESC);
CREATE INDEX deliveries_status_idx ON deliveries (status, sent_at DESC);
CREATE INDEX deliveries_in_transit_idx ON deliveries (id) WHERE status = 'in_transit' AND direction = 'to_project';

CREATE TABLE delivery_lines (
  delivery_id bigint NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material_id integer NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (delivery_id, material_id)
);
CREATE INDEX delivery_lines_material_idx ON delivery_lines (material_id);
