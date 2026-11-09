# SiteTrack API

This is my backend for the SiteTrack take-home from Seron Labs. It is a TypeScript API on Fastify with PostgreSQL. It tracks construction projects, their tasks and the materials that move between the company store and the project stores.

## How to run it

You need Docker. Nothing else.

```sh
docker compose up --build
```

That starts Postgres and the API. The API applies its database migrations on startup, so it is ready to use as soon as it logs `Server listening`.

- API: http://localhost:8080
- API docs (Swagger UI): http://localhost:8080/docs
- OpenAPI file: [`docs/openapi.json`](docs/openapi.json), the same document the API serves at `/docs/json`
- Postgres is also published on host port 54330 (user, password and database are all `sitetrack`), so you can poke at it with `psql`.

### Loading data at the brief's scale

With the stack running:

```sh
docker compose exec db psql -U sitetrack -d sitetrack -f /seed/seed.sql
```

It wipes the database and fills it in about 3.5 minutes on my laptop. The seed is plain SQL in [`db/seed.sql`](db/seed.sql), built from `generate_series`, so it needs no extra tools. It creates:

| Data | Rows |
|---|---|
| Users | 5,000 |
| Projects | 2,000 (10 of them have 3,000 tasks and 50 members) |
| Project members | about 43,000 |
| Invitations | about 51,000 |
| Tasks | about 502,000 |
| Task dependencies | about 1,005,000 |
| Materials | 20,000 |
| Deliveries | 400,000 |
| Delivery lines | 3,000,000 |

Every seeded user has the password `password123`. These three are handy for trying things out:

| Email | Role |
|---|---|
| `admin@sitetrack.test` | SuperAdmin |
| `manager@sitetrack.test` | Company store manager |
| `user@sitetrack.test` | User, member of 54 projects including two big ones that are still running |

The data is meant to look like a company that has used the app for years. Projects start between 2019 and 2027. A project's tasks spread across its planned dates. Tasks before today's progress line are done, a thin band after it is in progress, and the rest have not started. So old projects are mostly finished, current ones are part way, and future ones have not begun. That gives a realistic mix of late and blocked tasks. Dependencies always point from a higher task number to a lower one, so the graph can never have a loop. In-progress tasks only wait on done tasks, so the seeded statuses obey the Start rule. Deliveries from the last five days are still in transit, and project stock is worked out from the deliveries.

### Quick tour with curl

```sh
TOKEN=$(curl -s localhost:8080/auth/login -H 'content-type: application/json' \
  -d '{"email":"user@sitetrack.test","password":"password123"}' | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')
curl -s localhost:8080/projects -H "authorization: Bearer $TOKEN"
curl -s "localhost:8080/projects/PRJ-1770/tasks?blocked=true" -H "authorization: Bearer $TOKEN"
```

## The API in short

The full reference is the Swagger UI at `/docs`. Every list takes `page` and `pageSize` (up to 200) and answers `{ items, page, pageSize, total }`. Errors always look like `{ "error": "code", "message": "text" }`.

| Screen | Endpoints |
|---|---|
| 1, 2. Log in, register | `POST /auth/login`, `POST /auth/register`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` |
| 3. Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read`, `POST /invitations/{id}/accept`, `POST /invitations/{id}/reject` |
| 4. Projects | `GET /projects`, `POST /projects`, `GET/PATCH/DELETE /projects/{projectId}` |
| 5. Project tasks | `GET /projects/{projectId}/tasks`, `POST /projects/{projectId}/tasks` |
| 6. Task details | `GET/PATCH/DELETE .../tasks/{taskId}`, `POST .../tasks/{taskId}/start`, `/done`, `/reopen`, `POST .../tasks/{taskId}/dependencies`, `DELETE .../tasks/{taskId}/dependencies/{dependsOnId}` |
| 7. Project store | `GET /projects/{projectId}/store` |
| 8. Project deliveries | `GET /projects/{projectId}/deliveries`, `POST /projects/{projectId}/deliveries` (send back to the company store), `POST /deliveries/{id}/record`, `/reject`, `/cancel` |
| 9. Project members | `GET /projects/{projectId}/members`, `POST /projects/{projectId}/invitations`, `DELETE /projects/{projectId}/invitations/{id}`, `PATCH /projects/{projectId}/members/{userId}`, `DELETE /projects/{projectId}/members/{userId}` |
| 10. Company stock | `GET /company-store/stock`, `POST /company-store/stock/{materialId}/add`, `PATCH /company-store/stock/{materialId}` |
| 11. Company deliveries | `GET /company-store/deliveries`, `POST /company-store/deliveries`, `GET /company-store/projects` (project picker) |
| Materials catalogue | `GET /materials`, `GET /materials/categories`, `GET/POST/PATCH/DELETE /materials/{id}` |

Projects and tasks use their public IDs in URLs, like `/projects/PRJ-0042/tasks/PRJ-0042-T-0137`. A task can also be addressed by its bare number (`137`).

## Decisions and why

### Stack

Fastify with the `pg` driver and plain SQL, no ORM. Most of the hard parts here are queries (recursive walks, row locks, conditional updates), and I wanted to see and tune the exact SQL. Fastify's JSON schemas do three jobs at once: they validate input, they shape output, and they generate the OpenAPI docs, so the docs can't drift from the code.

### Migrations

Plain numbered SQL files in `migrations/`. The API applies any new ones on startup inside a transaction, holding a Postgres advisory lock so two API containers can't race. A small table records which ones ran.

### Login and sessions

Logging in creates a session row and returns two tokens. The access token is a JWT that lasts 15 minutes. The refresh token is a random secret tied to the session, stored only as a SHA-256 hash, and it keeps the session alive for 30 days from the last refresh. Each refresh token works once and is swapped for a new one. If an old one is replayed, I treat it as stolen and end the whole session. Every request checks the JWT and then checks the session row is still live, so logging out stops that session at once, even with an unexpired access token. This costs one primary-key lookup per request, which I think is the right price for real logout. Passwords are hashed with scrypt from Node's standard library. A failed login gives the same answer for an unknown email and a wrong password, and an unknown email still runs a full scrypt check against a dummy hash, so timing doesn't give it away either.

### Access checks

The app role comes from the session lookup and the project membership comes from a fresh query, both on every request. Nothing about access is cached in the token. That is what makes a removal or an admin change bite on the very next request. Anything inside a project you can't access answers `404 Project not found`, word for word the same as an ID that doesn't exist. Lists are built from the caller's memberships, so they never include projects the caller can't see. Inside a project you are a member of, trying an admin-only action gives `403`, because there the project's existence is no secret.

### Roles

SuperAdmins act as project admins on every project, without being members. Company store managers see the company store, every delivery, and a list of project IDs and names so they can pick where to send things. They don't see inside projects they are not members of.

### IDs

A project's number is its primary key. New numbers come from a counter row bumped with `UPDATE counters ... RETURNING value` inside the insert's transaction. The row lock makes concurrent creates queue, and a rolled-back create leaves a gap rather than a reused number. Each project has its own `task_counter` bumped the same way. Deleting never lowers a counter, so IDs are never reused. I print IDs with at least four digits, so project 12345 becomes `PRJ-12345` rather than being cut short.

### Dependencies

The table stores the project ID next to both task IDs, with composite foreign keys, so the database itself refuses a link across projects. Adding a link takes a lock on the project row, then a recursive query checks whether the new upstream task already waits on the task. If it does, the link would close a loop and is refused. The lock matters: two requests adding A→B and B→A at the same moment would each pass the check alone. With the lock, the second one sees the first.

### Status rules

The three actions (`start`, `done`, `reopen`) each check the current status and the graph, under the same project lock:
- Start needs every task it waits on, directly or not, to be done.
- Mark as done needs In progress.
- Reopen needs every task that waits on it, directly or not, to still be Not started.

Anything else is a `409`. The lock stops a Start and a Reopen next door from both passing their checks at once.

### Late and Blocked are never stored

They are worked out on every read from `current_date` and the graph. Blocked is the tricky one. Following the brief, a task is Blocked when it is not done and any task it reaches upstream is not done. That is not the same as "a direct dependency is not done or Blocked". A Done task can still sit downstream of a not-done task when a dependency was added after it was finished, and Done tasks are never flagged Blocked. So the "is a direct dependency blocked" shortcut would miss the chain. I compute it the other way round. I start from every not-done task, walk downstream with a recursive query, and every task reached is waiting on something. The not-done ones among them are Blocked. Each task is visited once, so a 3,000-task project takes a few milliseconds.

### Adding dependencies to tasks that already started

I allow it. The brief's Blocked rule talks about tasks that are "not done", which includes In progress, and that only makes sense if a started task can gain a new dependency. The task then shows as Blocked, which tells the team something changed under it. Refusing would also make it impossible to record a dependency someone forgot.

### Task details

It loads the project's whole edge list (at most a few thousand rows) and does a breadth-first walk in memory in both directions. That gives the smallest number of steps to each related task, which a recursive SQL query can't do cheaply on a graph with many paths.

### Stock never goes negative

Every send locks the sender's stock rows with `SELECT ... FOR UPDATE`, in material order, then checks each quantity and subtracts. Locking in a fixed order means two deliveries with overlapping materials queue up instead of deadlocking. A `CHECK (quantity >= 0)` on both stock tables is the last line of defence. Adding stock, initiating, recording, rejecting and cancelling each run in one transaction. Record, reject and cancel lock the delivery row and refuse anything that is no longer In transit, so two people answering at once can't both move stock.

### Who does what with a delivery

A delivery always runs between the company store and one project, so project-to-project is impossible by design. Its direction is `to_project` or `to_company`. The receiver records or rejects it. For `to_project` that is any project member, and for `to_company` it is a store manager. The sender can cancel it. For `to_project` that is a store manager, and for `to_company` a project member. SuperAdmins can do both sides.

### Materials catalogue

Everyone logged in can read it. Only store managers and SuperAdmins add, edit or remove materials, since they run the warehouse. A material with any stock or delivery history can't be removed.

### Task dates

They must end on or after they start, but they may fall outside the project's planned dates. Plans slip, and refusing a task because the project dates are stale would only get in the way.

### Removing things

A project removal is refused while its store holds stock or a delivery is in transit, so material can't vanish. Removing a task drops its dependency links.

### Notifications

They are the invitations sent to you, newest first. Withdrawn ones disappear. Answering an invitation also marks it read, and `POST /notifications/read` with `{}` marks the rest.

### Search and filters

Project search matches the name or the ID (`PRJ-0042`, `0042` or `42`). Task search works the same way. The task date filter keeps tasks whose planned period overlaps the given range. The delivery date filter uses the sent date.

## Speed at full scale

I loaded the full seed, then ran `EXPLAIN ANALYZE` on the queries behind each screen and timed every endpoint over HTTP. These fixes came out of that:

- The Blocked walk and the late counts were scanning every task. Most tasks in a company that has run for years are done, so a partial index on only the not-done tasks cut that work to about an eighth (`migrations/002_screen_indexes.sql`).
- For a SuperAdmin, the projects screen counted all 500,000 tasks on every request just to get totals and the done count. I now keep `task_total` and `task_done` on the project row. They change in the same transaction as the task, under the same lock, so they can't drift. The late, not-started and in-progress counts still come from the not-done index, because Late depends on today's date.
- On some pages Postgres guessed the recursive step would return far more rows than it did. It then read all 1,000,000 dependency rows on every step, which took 300 to 600 ms. Two things fixed it. `OFFSET 0` inside a lateral subquery makes each step a plain index lookup per task. `random_page_cost=1.1` tells the planner the disk is an SSD. The same page now takes about 16 ms in the database.
- Postgres was spending about 150 ms compiling these queries to machine code before running them, which costs far more than it saves on queries this short. I turned it off in `docker-compose.yml`.
- The deliveries lists pick the page's IDs from a `(sent_at, id)` index first, then join names onto those rows only. Page 2,000 of the company deliveries went from 333 ms to 35 ms (`migrations/003_delivery_page_indexes.sql`).

These are the final numbers. Each is the median of three warm requests over HTTP, from my laptop to the API in Docker (Postgres with 512 MB shared buffers). The big project `PRJ-1770` has 3,000 tasks and is about three quarters done. `PRJ-1970` has 3,000 tasks and has barely started, so almost all of them are open. The demo user is in 54 projects, including both. Default page size is 50.

| Screen | Request | Time |
|---|---|---|
| Log in | `POST /auth/login` (one scrypt hash, same for an unknown email) | about 50 ms |
| Notifications | `GET /notifications` | 8 ms |
| Notifications | `GET /notifications/unread-count` | 6 ms |
| Projects, user | `GET /projects` | 31 ms |
| Projects, user | `GET /projects?sort=lateTasks&order=desc` | 21 ms |
| Projects, SuperAdmin (all 2,000) | `GET /projects` | 44 ms |
| Projects, SuperAdmin | `?sort=lateTasks&order=desc` | 46 ms |
| Projects, SuperAdmin | `?sort=percentDone&order=desc&page=10` | 39 ms |
| Projects, SuperAdmin | `?sort=startDate&order=desc` | 80 ms |
| Projects, SuperAdmin | `?lateOnly=true` | 41 ms |
| Projects, SuperAdmin | `?q=riverside` | 21 ms |
| Projects, SuperAdmin | `?sort=startDate&order=desc&pageSize=200` (worst case) | 232 ms |
| Project tasks, 3,000 tasks | `GET /projects/PRJ-1770/tasks` | 20 ms |
| Project tasks | `?sort=dependents&order=desc` | 20 ms |
| Project tasks | `?blocked=true` | 22 ms |
| Project tasks | `?late=true&sort=endDate` | 21 ms |
| Project tasks | `?q=slab` | 22 ms |
| Project tasks | `?from=2026-01-01&to=2026-03-01&page=2` | 19 ms |
| Project tasks, mostly open | `GET /projects/PRJ-1970/tasks?blocked=true&sort=dependents&order=desc` | 29 ms |
| Task details | `PRJ-1770-T-3000` (1,500 tasks upstream, 83 KB) | 16 ms |
| Task details | `PRJ-1770-T-1500` | 19 ms |
| Project store | `GET /projects/PRJ-1770/store?sort=lastDelivery&order=desc` | 7 ms |
| Project store | `?q=cement&sort=quantity` | 8 ms |
| Project deliveries | `GET /projects/PRJ-1770/deliveries` | 21 ms |
| Project deliveries | `?direction=to_company&status=delivered` | 17 ms |
| Project members | `GET /projects/PRJ-1770/members` | 5 ms |
| Company stock (20,000 materials) | `GET /company-store/stock` | 41 ms |
| Company stock | `?sort=status` | 38 ms |
| Company stock | `?status=low_stock&category=Steel` | 23 ms |
| Company stock | `?page=300` | 60 ms |
| Company deliveries (400,000) | `GET /company-store/deliveries` | 42 ms |
| Company deliveries | `?status=in_transit` | 11 ms |
| Company deliveries | `?projectId=PRJ-1770` | 11 ms |
| Company deliveries | `?from=2023-01-01&to=2023-01-31` | 19 ms |
| Company deliveries | `?page=2000` | 35 ms |
| Materials | `GET /materials?q=cement` | 8 ms |

Everything a screen loads by default is under 100 ms. The slowest request I found is a SuperAdmin asking for 200 future projects at once, at about 230 ms, because every task in those projects is open and gets walked for the Blocked count.

## Trade-offs I accepted

- Blocked counts on the projects screen are only worked out for the page being returned, not for all projects. That keeps the screen fast, and the brief doesn't ask to sort or filter projects by blocked count.
- The project lock serialises dependency changes, status actions, task creation and member changes within one project. For a construction team that's never a real queue, and it makes the rules easy to trust.
- Offset pagination. It is simple for a frontend with page numbers. Deep pages still cost a little more, because Postgres has to count past the skipped rows on the index. A cursor would make every page cost the same.
- One refresh token per session. If two browser tabs refresh at the same moment, one of them looks like a replay and the session ends. A short grace window for the previous token would fix that.
- Anyone can register as any role, because the brief says the role is chosen at registration. In a real product, only a SuperAdmin would grant the higher roles.
- Project stock in the seed is worked out from the seeded deliveries, with a floor of zero where seeded returns would have gone below it.

## What I would do with more time

- Rate limiting on login and register.
- An audit log of stock additions, so the company store's history is as complete as the deliveries.
- Cursor pagination for the deliveries screens.
- Cache the Blocked count per project if SuperAdmins often ask for very large pages.
- Let project admins set the roles for new members in the invitation itself.
- Proper automated tests. For this submission I checked the rules by running them against the live API (see below), but I didn't commit those scripts.
- Soft delete for projects, so the company store's delivery history keeps rows for removed projects.

## How I built this

I used an AI coding agent for most of the design and implementation: sessions, the 404 rule, counters, the lock and walk for dependencies, row locks for stock. I checked the result by running it, not by reading it alone. Here is what I ran against the live stack after a clean `docker compose down -v && docker compose up`:

- The full seed, then the timings above.
- A throwaway script that hit every rule. It covered: the same 404 for non-members and missing projects, on every project screen. It covered logout killing both tokens while another session stays live, and refresh rotation with replay detection. It checked that removal and demotion bite on the very next request, and that the last admin can't be removed or demoted. It ran the invite, accept and answer-once flow. It checked cycle rejection, including two opposite links sent at the same instant (one wins). It ran every status transition, including Blocked through a chain of done tasks.
- Concurrency checks. 50 deliveries of 7 units fired at once against 100 in stock gave exactly 14 successes and 2 units left. 20 returns fired at once from a project store never went below zero. A record, a reject and a cancel on the same delivery at once had exactly one winner. 40 tasks created at once got IDs 1 to 40 with no gaps or repeats, and 20 projects created at once all got distinct IDs.
