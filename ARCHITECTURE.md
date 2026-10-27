# Architecture

How IWM is built. Each section is marked **Built** (in this repository today)
or **Planned** (the direction, not yet implemented).

---

## Structure

```
 ┌──────────────────────────────── APPS ────────────────────────────────┐
 │      Web            Desktop          Mobile         Client portal    │
 │   (Next.js)       (Electron)         (Expo)           (Next.js)      │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    │  HTTPS: REST /api/v1 + Socket.IO
                                    ▼
 ┌─────────────────────────── REVERSE PROXY ────────────────────────────┐
 │               Caddy / Nginx, or a cloud load balancer                │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    ▼
 ┌──────────────── BACKEND: one NestJS codebase, ROLE=... ──────────────┐
 │   ┌──────────────────────────┐        ┌──────────────────────────┐   │
 │   │           api            │        │          worker          │   │
 │   │  HTTP + Socket.IO (chat, │        │  BullMQ jobs, IMAP IDLE, │   │
 │   │  presence, notifications)│        │  crons, boot-time work   │   │
 │   └──────────────────────────┘        └──────────────────────────┘   │
 │                 ROLE=all (default) runs both in one process          │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    ▼
 ┌──────────────────────────────── DATA ────────────────────────────────┐
 │     PostgreSQL               Redis                 File storage      │
 │     all records          queues, cache,          MinIO / any S3-     │
 │     (via Prisma)          presence             compatible store      │
 └──────────────────────────────────────────────────────────────────────┘
       Side services: Gotenberg (HTML to PDF), LiveKit (WebRTC calls)
```

The desktop and mobile apps are thin shells around the hosted web app. They
add a tray, deep links, OS notifications and native push.

## Modules

```
 Sign-in and sessions        Projects, tasks, sprints, goals, saved views
 Organizations, workspaces   Leads and clients, client portal, signatures
 Roles and permissions       Invoices, contracts, payments, expenses
 Custom fields, task forms   Chat, presence, LiveKit calls
 Documents and files         Mail (per-user IMAP/SMTP)
 Notifications               HR: attendance, leave, timesheets, payroll
 Search                      Audit log, support access, security alerts
```

---

## 1. One codebase, separate processes (Built)

The same API build runs as `api`, `worker` or `all`, chosen by the `ROLE`
environment variable (read from the real process environment, never from
`.env`):

- `all` (default): one process does everything. Right for small installs.
- `api`: HTTP and Socket.IO only. It enqueues jobs but runs no workers.
- `worker`: BullMQ workers, IMAP IDLE, crons and boot-time work, plus a small
  health server on `WORKER_HEALTH_PORT`.

`api` and `worker` run as a pair, with exactly one process doing background
work: the IMAP watcher and the crons assume a single instance. Each process
announces itself in Redis, and the API logs a clear error when the setup is
wrong (for example two background processes, or none).

## 2. Private by design (Built)

```
 Platform admin ──► run the server, manage orgs, see usage    ✗ org data
 Org admin      ──► everything inside their own org           ✗ other orgs
 Support        ──► only with a time-limited grant from the org, logged
```

- **Platform admins** (`SUPER_ADMIN`, members of the root platform
  organization) manage organizations and usage but cannot read an
  organization's projects, chat, mail, files or money.
- **Support access**: an organization admin can grant platform support a
  time-limited, scoped and audited window into their organization, and revoke
  it at any time.
- **Audit log** each organization can read, including support actions.
- **Security alerts**: bursts of failed sign-ins, mass deletes and very large
  imports or exports raise alerts in the affected organization's audit log (and the
  platform log). Alerts carry counts and ids only, never content.
- Secrets come from the environment; mail credentials are encrypted at rest
  with `MAIL_ENCRYPTION_KEY`.

## 3. Organizations kept apart (Built in the API; Planned in the database)

```
 request ──► backend adds "this org only" ──► (planned) database row-level rule ──► data
                  (layer 1, built)                      (layer 2)
```

Every request resolves the caller's organization and workspace scope, and
services filter by it. Row-level security in PostgreSQL as a second layer is
planned. Files are stored under a separate prefix per workspace.

## 4. Roles and permissions (Built)

System roles (`SUPER_ADMIN`, `ADMIN`, `PROJECT_MANAGER`, `HR`, `FINANCE`,
`EMPLOYEE`), workspace and project roles, custom roles and per-user overrides,
evaluated with CASL on the server. The frontend uses the same abilities only
to hide what a user cannot do; the server is authoritative.

## 5. Notifications on every device (Built)

```
 event ──► saved in DB ──► worker ──┬──► web / desktop   live Socket.IO connection
                                    ├──► browser         Web Push (VAPID)
                                    ├──► mobile          Expo push
                                    └──► desktop         system notification
```

Mute settings apply everywhere. Clicking a notification opens the right page.

## 6. Search (Built)

PostgreSQL full-text search over messages, files, documents, tasks, projects,
clients and leads, with Slack-style filters (`in:#channel`, `from:@person`,
`has:file`, `before:2026-01-01`). Results respect permissions. The expression
indexes that make it fast on large data are not shipped in this release yet
(see the README).

## 7. Remember me and devices (Built)

```
 Sign in ──┬── Remember me ✓ ──► session cookie that lasts 30 days
           └── Remember me ✗ ──► session that ends when the browser or app closes
```

A Devices page lists every signed-in session and can sign any of them out.

## 8. Core and add-ons (Planned)

Today mail, cPanel mailbox provisioning, payments, SMS/calls, video and HR are
part of the core and switched on through environment variables and
organization feature flags. The plan is one add-on interface: each add-on
stores its settings per organization (encrypted), the apps hide anything that
is off, and every outside service has a free default:

```
 File storage  MinIO ─────► S3, R2          Search  PostgreSQL ─► Meilisearch
 Mobile push   Expo ──────► Firebase, APNs  PDFs    Gotenberg
 Video         LiveKit ───► LiveKit Cloud   SMS     off ────────► Twilio, Vonage
```

## 9. AI assistants and API tokens (Planned)

```
 AI tool ──► sign-in page ──► consent screen ──► scoped token ──► MCP server
                              "Read clients ✓
                               Delete ✗"
```

Personal API tokens first, then an MCP server with OAuth sign-in. An assistant
can never do more than its user, is read-only by default, can be turned off
per organization, and every action is logged on the user's behalf.

## 10. Live co-editing (Planned)

Documents use Tiptap today, with revisions. Google Docs-style co-editing with
Yjs and Hocuspocus, run as an optional `collab` process, is planned.

## 11. Install and scale (Partly built)

- **Built:** `docker-compose.yml` for the backing services (Postgres, Redis,
  MinIO, Gotenberg, LiveKit) and the `api` / `worker` split.
- **Planned:** published Docker images for the apps, a Helm chart, and a setup
  screen that creates the first admin.

```
 Small  (<200 users)   one server, Docker Compose, ROLE=all
 Medium (≤5,000)       2+ API servers + one worker, load balancer, hosted DB and Redis
 Large  (5,000+)       autoscaling, PgBouncer, read replicas
```

Processes keep no state in memory, lists load in pages, and uploads go
straight to object storage.
