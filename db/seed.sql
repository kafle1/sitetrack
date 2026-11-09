-- Fills an empty, migrated database with data at the brief's scale.
-- Run it with: docker compose exec db psql -U sitetrack -d sitetrack -f /seed/seed.sql
-- Everyone's password is password123. Wipes whatever is there first.

\set ON_ERROR_STOP on
\timing on

BEGIN;

TRUNCATE users, sessions, projects, project_members, invitations, tasks, task_dependencies,
  materials, company_stock, project_stock, deliveries, delivery_lines RESTART IDENTITY CASCADE;

-- users: 5,000. ids 1 to 3 are the demo logins, every 250th is a SuperAdmin, every 50th (plus one) a store manager
INSERT INTO users (id, name, email, password_hash, role, created_at)
SELECT i,
  (ARRAY['Aarav','Sita','Ram','Gita','Hari','Maya','Bikash','Anita','Suman','Priya','Rohan','Kriti','Nabin','Asha','Dipesh',
         'Laxmi','Sanjay','Puja','Arjun','Rekha','Kiran','Nisha','Prakash','Sunita','Manish','Bina','Rajesh','Sarita','Amit','Kamala',
         'James','Emma','Oliver','Sophia','Liam','Ava','Noah','Mia','Lucas','Chloe'])[1 + (i * 7) % 40]
  || ' ' ||
  (ARRAY['Sharma','Thapa','Gurung','Shrestha','Rai','Tamang','Karki','Adhikari','Poudel','Bhandari','Khadka','Magar','Joshi',
         'Basnet','Koirala','Lama','Pandey','Regmi','Acharya','Maharjan','Smith','Brown','Wilson','Taylor','Clark'])[1 + (i * 13) % 25],
  CASE i WHEN 1 THEN 'admin@sitetrack.test' WHEN 2 THEN 'manager@sitetrack.test' WHEN 3 THEN 'user@sitetrack.test'
         ELSE 'user' || i || '@sitetrack.test' END,
  'scrypt$5e7a0c11d00d5eed5e7a0c11d00d5eed$631b18556420fecaa244052aba21e62b81a75590e83227ebaf7a3de3a23c02bd',
  (CASE WHEN i = 1 OR i % 250 = 0 THEN 'superadmin' WHEN i = 2 OR i % 50 = 1 THEN 'store_manager' ELSE 'user' END)::app_role,
  now() - make_interval(days => 1500 + (i % 300))
FROM generate_series(1, 5000) i;
SELECT setval('users_id_seq', 5000);

-- projects: 2,000. Every 200th project (170, 370, ...) is a big one with 3,000 tasks and 50 members
CREATE TEMP TABLE seed_projects AS
SELECT p AS id,
  (ARRAY['Riverside','Harbour View','Kathmandu Heights','Northgate','Lakeside','Hillcrest','Greenfield','Old Town','Summit',
         'Eastbank','Westpoint','Bagmati','Patan','Sunrise','Cedar Park','Maple Court','Stonebridge','Valley','Kingsway','Ringroad'])[1 + p % 20]
  || ' ' ||
  (ARRAY['Apartments','Office Block','Hospital Wing','School Campus','Shopping Centre','Bridge','Warehouse','Hotel',
         'Car Park','Metro Station','Data Centre','Library','Sports Hall','Water Treatment Plant','Housing Estate'])[1 + (p / 20) % 15]
  || CASE WHEN p % 3 = 0 THEN ' Phase ' || (1 + p % 4) ELSE '' END AS name,
  (date '2019-01-01' + (p * 1.45)::int) AS planned_start,
  (date '2019-01-01' + (p * 1.45)::int + 180 + (p * 53) % 900) AS planned_end,
  CASE WHEN p % 200 = 170 THEN 3000 ELSE 137 + (p * 37) % 201 END AS task_count,
  CASE WHEN p % 200 = 170 THEN 50 ELSE 3 + (p * 29) % 38 END AS member_count
FROM generate_series(1, 2000) p;

-- how far along each project is today, as a share of its planned duration
ALTER TABLE seed_projects ADD COLUMN progress float, ADD COLUMN frontier int, ADD COLUMN in_progress int;
UPDATE seed_projects SET progress = least(1, greatest(0, (current_date - planned_start)::float / (planned_end - planned_start)));
UPDATE seed_projects SET
  frontier = CASE WHEN progress >= 1 AND id % 7 <> 0 THEN task_count ELSE floor(task_count * progress * 0.97)::int END,
  in_progress = CASE WHEN progress > 0 THEN greatest(1, task_count / 30) ELSE 0 END;

-- member slot i of project p is user ((p * 7919 + i * 104729) % 5000) + 1; 104729 is prime so slots never repeat a user
CREATE FUNCTION pg_temp.slot_user(p int, i int) RETURNS bigint LANGUAGE sql IMMUTABLE AS
  $$ SELECT ((p::bigint * 7919 + i::bigint * 104729) % 5000) + 1 $$;

INSERT INTO projects (id, name, planned_start, planned_end, task_counter, created_by, created_at)
SELECT id, name, planned_start, planned_end, task_count, pg_temp.slot_user(id, 1), planned_start - 30
FROM seed_projects;
UPDATE counters SET value = 2000 WHERE name = 'project';

INSERT INTO project_members (project_id, user_id, is_admin, joined_at)
SELECT sp.id, pg_temp.slot_user(sp.id, i), i = 1 OR (i = 2 AND sp.member_count > 10) OR (i = 3 AND sp.member_count > 30),
  sp.planned_start - 30 + (i % 20)
FROM seed_projects sp, generate_series(1, sp.member_count) i;

-- the demo user is in 54 projects, admin of some, and in the big ones
INSERT INTO project_members (project_id, user_id, is_admin, joined_at)
SELECT id, 3, id % 120 = 0, planned_start FROM seed_projects WHERE id % 60 = 0 OR id % 200 = 170 OR id IN (1990, 1995)
ON CONFLICT (project_id, user_id) DO UPDATE SET is_admin = EXCLUDED.is_admin OR project_members.is_admin;

-- invitations: one accepted invitation behind every member who did not create the project,
-- then pending, rejected and withdrawn ones to other users until the total reaches 50,000
INSERT INTO invitations (project_id, user_id, invited_by, status, created_at, answered_at, read_at)
SELECT pm.project_id, pm.user_id, p.created_by, 'accepted', pm.joined_at - interval '2 days', pm.joined_at, pm.joined_at
FROM project_members pm JOIN projects p ON p.id = pm.project_id
WHERE pm.user_id <> p.created_by;

INSERT INTO invitations (project_id, user_id, invited_by, status, created_at, answered_at, read_at)
SELECT sp.id, pg_temp.slot_user(sp.id, i), pg_temp.slot_user(sp.id, 1),
  (CASE WHEN i % 10 < 4 THEN 'pending' WHEN i % 10 < 8 THEN 'rejected' ELSE 'withdrawn' END)::invitation_status,
  least(now() - interval '1 day', sp.planned_start + (i * 3)) AS created_at,
  CASE WHEN i % 10 >= 4 THEN least(now(), sp.planned_start + (i * 3) + 2) END,
  CASE WHEN i % 10 >= 4 OR i % 3 = 0 THEN least(now(), sp.planned_start + (i * 3) + 1) END
FROM seed_projects sp,
  generate_series(51, 50 + ceil((50000 - (SELECT count(*) FROM invitations)) / 2000.0)::int) i
WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = sp.id AND m.user_id = pg_temp.slot_user(sp.id, i));

-- a few open invitations for the demo user so the notifications screen has something to answer
INSERT INTO invitations (project_id, user_id, invited_by, status, created_at)
SELECT sp.id, 3, pg_temp.slot_user(sp.id, 1), 'pending', now() - make_interval(days => sp.id % 20)
FROM seed_projects sp
WHERE sp.id IN (1201, 1302, 1403, 1504, 1605)
  AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = sp.id AND m.user_id = 3)
ON CONFLICT DO NOTHING;

-- tasks: about 500,000. Planned dates spread across the project; everything before today's frontier is done,
-- a thin band after it is in progress, the rest has not started
INSERT INTO tasks (project_id, number, name, planned_start, planned_end, status, created_at)
SELECT sp.id, n,
  (ARRAY['Excavate foundations','Pour concrete slab','Install formwork','Fix reinforcement steel','Lay blockwork',
         'Install windows','First fix electrics','Second fix electrics','First fix plumbing','Second fix plumbing',
         'Plaster walls','Screed floors','Install roof trusses','Waterproof basement','Paint interiors','Install HVAC ducts',
         'Tile bathrooms','Hang drywall','Install lift','Fit kitchens','Commission fire alarm','Erect scaffolding',
         'Strike scaffolding','Install facade panels','Pave access road','Survey and set out','Pile driving',
         'Install drainage','Fit doors and frames','Snagging walkthrough'])[1 + (n * 7 + sp.id) % 30]
  || ', ' ||
  (ARRAY['level ' || (1 + n % 12), 'Block ' || chr(65 + n % 6), 'east wing', 'west wing', 'basement', 'roof',
         'zone ' || (1 + n % 9), 'stair core ' || (1 + n % 3)])[1 + (n * 3) % 8],
  sp.planned_start + floor((n - 1)::float / sp.task_count * greatest(1, sp.planned_end - sp.planned_start - 30))::int,
  sp.planned_start + floor((n - 1)::float / sp.task_count * greatest(1, sp.planned_end - sp.planned_start - 30))::int + 2 + (n * 31) % 25,
  (CASE WHEN n <= sp.frontier THEN 'done' WHEN n <= sp.frontier + sp.in_progress THEN 'in_progress' ELSE 'not_started' END)::task_status,
  sp.planned_start - 20
FROM seed_projects sp, generate_series(1, sp.task_count) n
ORDER BY sp.id, n;

UPDATE projects p SET task_total = s.total, task_done = s.done
FROM (SELECT project_id, count(*) AS total, count(*) FILTER (WHERE status = 'done') AS done FROM tasks GROUP BY project_id) s
WHERE s.project_id = p.id;

-- dependencies: 1 to 3 per task, always on a lower-numbered task, so the graph can never have a loop.
-- In-progress tasks only wait on done tasks, so the seeded statuses obey the Start rule.
INSERT INTO task_dependencies (project_id, task_id, depends_on_id)
SELECT t.project_id, t.id, u.id
FROM tasks t
JOIN seed_projects sp ON sp.id = t.project_id
CROSS JOIN LATERAL (VALUES (1, 1 + (t.number * 13) % 4), (2, 5 + (t.number * 17) % 20), (3, 25 + (t.number * 19) % 120)) o(k, step)
CROSS JOIN LATERAL (SELECT CASE WHEN t.status = 'in_progress' THEN sp.frontier + 1 - o.step ELSE t.number - o.step END AS target) x
JOIN tasks u ON u.project_id = t.project_id AND u.number = x.target
WHERE o.k <= CASE WHEN (t.number * 7 + t.project_id) % 10 < 2 THEN 1 WHEN (t.number * 7 + t.project_id) % 10 < 6 THEN 2 ELSE 3 END
  AND x.target >= 1
ON CONFLICT DO NOTHING;

-- materials: 20,000 catalogue items
INSERT INTO materials (id, name, category, unit, created_at)
SELECT i,
  b.name || ', ' || (ARRAY['standard','heavy duty','premium','economy','fire rated','marine grade','low VOC','recycled',
    'galvanised','pre-cut','grade A','grade B','type 1','type 2','type 3','imported','local','bulk pack','site pack','eco',
    'high strength','rapid set','frost resistant','UV stable','anti-slip','moisture resistant','acoustic','insulated'])[1 + (i / 720) % 28]
  || ' (' || (ARRAY['Northgate','Apex Supply','Kestrel','Ironbark','Bluestone','Meridian','Summit Trade','Harbor Co',
    'Redline','Granite and Co','Oakfield','Trident'])[1 + (i / 60) % 12] || ')',
  b.category, b.unit, now() - interval '5 years'
FROM generate_series(1, 20000) i
JOIN (VALUES
  (0,'Cement, OPC 50 kg bag','Cement','bag'),(1,'Cement, PPC 50 kg bag','Cement','bag'),(2,'White cement 25 kg','Cement','bag'),
  (3,'Rebar 8 mm','Steel','tonne'),(4,'Rebar 12 mm','Steel','tonne'),(5,'Rebar 16 mm','Steel','tonne'),(6,'Steel I-beam 200 mm','Steel','piece'),
  (7,'Binding wire','Steel','kg'),(8,'Mesh sheet A142','Steel','sheet'),(9,'Sand, fine','Aggregates','m3'),(10,'Sand, coarse','Aggregates','m3'),
  (11,'Gravel 20 mm','Aggregates','m3'),(12,'Crushed stone 40 mm','Aggregates','m3'),(13,'Ready-mix concrete C30','Concrete','m3'),
  (14,'Ready-mix concrete C40','Concrete','m3'),(15,'Precast lintel','Concrete','piece'),(16,'Concrete block 200 mm','Masonry','piece'),
  (17,'Clay brick','Masonry','piece'),(18,'AAC block','Masonry','piece'),(19,'Mortar mix 25 kg','Masonry','bag'),
  (20,'Plywood 18 mm','Timber','sheet'),(21,'Timber 50x100','Timber','m'),(22,'Formwork panel','Timber','piece'),(23,'MDF board 12 mm','Timber','sheet'),
  (24,'Copper cable 2.5 mm2','Electrical','m'),(25,'Copper cable 6 mm2','Electrical','m'),(26,'PVC conduit 25 mm','Electrical','m'),
  (27,'Distribution board','Electrical','piece'),(28,'LED panel light','Electrical','piece'),(29,'Socket outlet','Electrical','piece'),
  (30,'PVC pipe 110 mm','Plumbing','m'),(31,'PPR pipe 25 mm','Plumbing','m'),(32,'Gate valve 50 mm','Plumbing','piece'),
  (33,'Water tank 1000 L','Plumbing','piece'),(34,'Wash basin','Sanitary','piece'),(35,'WC pan','Sanitary','piece'),
  (36,'Emulsion paint 20 L','Paint','drum'),(37,'Enamel paint 4 L','Paint','tin'),(38,'Primer 20 L','Paint','drum'),
  (39,'Wall putty 40 kg','Finishes','bag'),(40,'Floor tile 600x600','Tiles','m2'),(41,'Wall tile 300x600','Tiles','m2'),
  (42,'Tile adhesive 20 kg','Tiles','bag'),(43,'Gypsum board 12.5 mm','Drywall','sheet'),(44,'Metal stud 70 mm','Drywall','m'),
  (45,'Glass wool roll','Insulation','roll'),(46,'XPS board 50 mm','Insulation','sheet'),(47,'Bitumen membrane','Waterproofing','roll'),
  (48,'Waterproof coating 20 kg','Waterproofing','pail'),(49,'Roof sheet 0.5 mm','Roofing','sheet'),(50,'Ridge cap','Roofing','piece'),
  (51,'Float glass 6 mm','Glass','m2'),(52,'Aluminium window frame','Windows','piece'),(53,'Flush door 900 mm','Doors','piece'),
  (54,'Anchor bolt M12','Fixings','box'),(55,'Drywall screw','Fixings','box'),(56,'Nails 75 mm','Fixings','kg'),
  (57,'Safety helmet','Safety','piece'),(58,'Safety harness','Safety','piece'),(59,'Scaffold tube 6 m','Scaffolding','piece')
) AS b(k, name, category, unit) ON b.k = i % 60;
SELECT setval('materials_id_seq', 20000);

-- company stock: every material, some out of stock, some low
INSERT INTO company_stock (material_id, quantity, reorder_point)
SELECT i,
  CASE WHEN i % 17 = 0 THEN 0 WHEN i % 11 = 0 THEN 10 + (i * 7) % 200 ELSE 300 + (i * 37) % 5000 END,
  CASE WHEN i % 11 = 0 THEN 250 + (i * 7) % 200 ELSE 20 + (i * 7) % 480 END
FROM generate_series(1, 20000) i;

-- deliveries: 200 per project, 400,000 in all, about 1 in 7 going back to the company store.
-- Anything sent in the last 5 days is still in transit.
INSERT INTO deliveries (id, project_id, direction, status, sent_by, sent_at, received_by, received_at, cancelled_by, cancelled_at)
SELECT (sp.id - 1) * 200 + d, sp.id, dir, st,
  CASE WHEN dir = 'to_project' THEN 51 + 50 * ((sp.id + d) % 99) ELSE pg_temp.slot_user(sp.id, 1 + d % sp.member_count)::int END,
  sent,
  CASE WHEN st IN ('delivered', 'rejected') THEN
    CASE WHEN dir = 'to_project' THEN pg_temp.slot_user(sp.id, 1 + (d * 3) % sp.member_count)::int ELSE 51 + 50 * ((sp.id + d * 3) % 99) END END,
  CASE WHEN st IN ('delivered', 'rejected') THEN sent + make_interval(hours => 6 + d % 60) END,
  CASE WHEN st = 'cancelled' THEN CASE WHEN dir = 'to_project' THEN 51 + 50 * ((sp.id + d) % 99) ELSE pg_temp.slot_user(sp.id, 1 + d % sp.member_count)::int END END,
  CASE WHEN st = 'cancelled' THEN sent + interval '3 hours' END
FROM seed_projects sp
CROSS JOIN generate_series(1, 200) d
CROSS JOIN LATERAL (SELECT least(sp.planned_end, current_date - 1) AS b) w
CROSS JOIN LATERAL (SELECT (least(sp.planned_start - 30, w.b - 30) + floor((w.b - least(sp.planned_start - 30, w.b - 30)) * (d - 1) / 200.0)::int)::timestamptz
  + make_interval(hours => 7 + d % 10, mins => (d * 7) % 60) AS sent) s
CROSS JOIN LATERAL (SELECT (CASE WHEN d % 7 = 0 THEN 'to_company' ELSE 'to_project' END)::delivery_direction AS dir) x
CROSS JOIN LATERAL (SELECT (CASE WHEN s.sent > now() - interval '5 days' THEN 'in_transit' WHEN d % 25 = 0 THEN 'rejected'
  WHEN d % 25 = 1 THEN 'cancelled' ELSE 'delivered' END)::delivery_status AS st) y;
SELECT setval('deliveries_id_seq', 400000);

-- delivery lines: 1 to 14 per delivery, about 3,000,000. Each project draws from its own set of 300 materials.
INSERT INTO delivery_lines (delivery_id, material_id, quantity)
SELECT dl.id,
  ((dl.project_id::bigint * 131 + ((dl.id * 37 + j * 17) % 300) * 7919) % 20000) + 1,
  CASE WHEN dl.direction = 'to_project' THEN 5 + (dl.id * 13 + j * 29) % 496 ELSE 1 + (dl.id + j) % 20 END
FROM deliveries dl, generate_series(0, (dl.id * 7 + dl.project_id) % 14) j;

-- project stock follows from the deliveries: delivered in, minus what was sent back
INSERT INTO project_stock (project_id, material_id, quantity, last_delivery_at)
SELECT d.project_id, l.material_id,
  greatest(0, sum(CASE WHEN d.direction = 'to_project' AND d.status = 'delivered' THEN l.quantity
                       WHEN d.direction = 'to_company' AND d.status IN ('in_transit', 'delivered') THEN -l.quantity
                       ELSE 0 END)),
  max(CASE WHEN d.direction = 'to_project' THEN d.received_at ELSE d.sent_at END)
FROM deliveries d JOIN delivery_lines l ON l.delivery_id = d.id
WHERE d.direction = 'to_company' OR d.status = 'delivered'
GROUP BY d.project_id, l.material_id;

COMMIT;

VACUUM ANALYZE;

SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM projects) AS projects,
  (SELECT count(*) FROM project_members) AS members, (SELECT count(*) FROM invitations) AS invitations,
  (SELECT count(*) FROM tasks) AS tasks, (SELECT count(*) FROM task_dependencies) AS dependencies,
  (SELECT count(*) FROM materials) AS materials, (SELECT count(*) FROM deliveries) AS deliveries,
  (SELECT count(*) FROM delivery_lines) AS delivery_lines;
