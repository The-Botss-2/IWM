# IWM

An open-source, self-hostable all-in-one workspace for teams. It covers projects and tasks, leads, clients and a client portal, invoices and finance, chat and voice/video calls, documents and files, mail, and HR (attendance, leave, timesheets, payroll), on web, desktop and mobile.

IWM is a TypeScript monorepo: a NestJS API, a Next.js web app, an Electron desktop shell and an Expo mobile app, all sharing Zod schemas and a typed API client. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

## Table of contents

1. [What IWM is](#1-what-iwm-is)
2. [Tech stack and repository layout](#2-tech-stack-and-repository-layout)
3. [Requirements](#3-requirements)
4. [Quick start](#4-quick-start)
5. [Configuration](#5-configuration)
6. [Optional services](#6-optional-services)
7. [Process roles](#7-process-roles)
8. [Desktop and mobile apps](#8-desktop-and-mobile-apps)
9. [Invoice and payslip templates](#9-invoice-and-payslip-templates)
10. [Common commands](#10-common-commands)
11. [Not included in this release](#11-not-included-in-this-release)
12. [Security model](#12-security-model)
13. [Known limitations](#13-known-limitations)
14. [Contributing, security reporting and license](#14-contributing-security-reporting-and-license)

## 1. What IWM is

IWM replaces a stack of separate tools (chat, tasks, docs, CRM, invoicing, mail, HR) with one workspace you run yourself. It supports many organizations on one install, and each organization's data stays private to it.

### Built

- **Projects and tasks**: boards, sprints, goals, saved views, custom fields, task forms, comments, per-project roles and permissions.
- **Leads and clients**: pipeline stages and follow-ups, client hub, client portal with shared documents and signature requests.
- **Invoices and finance**: invoice templates rendered to PDF, contracts, milestones, payments, expenses, payment sources.
- **Communication**: channels, DMs and group chats with reactions and replies, presence, notifications on every device, LiveKit voice/video calls and screen share.
- **Mail**: per-user IMAP/SMTP accounts with signatures.
- **Documents and files**: rich-text editor (Tiptap), revisions, shareable public links, object storage for uploads.
- **HR**: attendance, leave, holidays, timesheets, payroll with payslips.
- **Organizations and access**: multi-organization tenancy, role-based and attribute-based permissions (CASL), audit log, time-limited support access, security alerts, device sessions with "remember me".
- **Search**: PostgreSQL full-text search with Slack-style filters such as `in:#channel`, `from:@person`, `has:file`.

### Planned

- Row-level security in PostgreSQL as a second tenant isolation layer.
- An add-on interface so optional services (mail, SMS, video, payments) are switched on per organization.
- Personal API tokens and an MCP server so AI assistants can act with scoped permissions.
- Live co-editing of documents (Yjs and Hocuspocus).
- Published Docker images, a Helm chart and a first-run setup screen.
- Polar payments and Twilio SMS/PSTN (the env vars exist, the integration does not yet).

Details and status for each item are in [ARCHITECTURE.md](ARCHITECTURE.md).

## 2. Tech stack and repository layout

| Area | Tools |
| --- | --- |
| API | NestJS, Prisma, PostgreSQL, Redis, BullMQ, Socket.IO |
| Web | Next.js 15 (App Router), TanStack Query, Zustand, Tailwind |
| Desktop and mobile | Electron, Expo + Expo Router |
| Auth and permissions | Better Auth, CASL |
| Documents | Tiptap (ProseMirror) |
| Calls | LiveKit (WebRTC) |
| Storage and PDFs | MinIO or any S3-compatible store, Gotenberg |
| Validation | Zod, shared across the stack |
| Tooling | pnpm workspaces, Turborepo, TypeScript strict mode |

```
apps/
  api/        NestJS backend (port 4000, routes under /api/v1)
  web/        Next.js 15 web app (port 3000)
  desktop/    Electron shell around the hosted web app
  mobile/     Expo WebView shell around the hosted web app
packages/
  database/      Prisma schema, demo seed, generated client
  shared-types/  Zod schemas and shared TypeScript types
  api-client/    Typed SDK the frontends use to call the API
  auth/          Better Auth config and CASL abilities
  config/        Shared eslint, tsconfig and tailwind preset
docker/          Postgres init script (pg_trgm)
docker-compose.yml  Local Postgres, Redis, MinIO, Gotenberg, LiveKit
```

## 3. Requirements

- Node.js 22.12 or newer
- pnpm 9 (enable it with `corepack enable`; the repo pins `pnpm@9.15.9`)
- Docker, for the local services
- PostgreSQL 16 with the `pg_trgm` extension (the compose file handles this)
- Redis 7

## 4. Quick start

1. Clone the repository and enter it.

   ```bash
   git clone <your-fork-or-this-repo-url> iwm
   cd iwm
   corepack enable
   ```

2. Install dependencies.

   ```bash
   pnpm install
   ```

3. Copy the env files.

   ```bash
   cp .env.example .env
   cp apps/web/.env.example apps/web/.env.local
   ```

   Edit `.env` and set at least `BETTER_AUTH_SECRET` and `MAIL_ENCRYPTION_KEY` (each: `openssl rand -hex 32`). Everything else is optional; see [Configuration](#5-configuration).

4. Start Postgres, Redis, MinIO, Gotenberg and LiveKit.

   ```bash
   docker compose up -d
   ```

   The compose credentials are development defaults, so change them before exposing a host. On first start the compose file installs `pg_trgm`. If you use your own PostgreSQL instead, run `CREATE EXTENSION IF NOT EXISTS pg_trgm;` in your database and in `template1` (Prisma's shadow database) before creating the schema.

5. Create the schema.

   ```bash
   pnpm db:migrate --name init
   ```

6. Seed demo data (idempotent, refuses to run in production).

   ```bash
   pnpm db:seed:dev
   ```

   The seed creates the root platform organization, a demo organization, a workspace, a sample project and one admin.

7. Run everything.

   ```bash
   pnpm dev
   ```

8. Open http://localhost:3000 and sign in.

   | Email | Password |
   | --- | --- |
   | `admin@example.com` | `demo-admin-password` |

   This account is for local development only. Change the password or delete the account before any real use.

To run one app only: `pnpm dev --filter=@botss/web` or `pnpm dev --filter=@botss/api` (API at http://localhost:4000/api/v1).

## 5. Configuration

The API reads the root `.env`. The web app reads `apps/web/.env.local`. Anything marked `NEXT_PUBLIC_` is baked into the web bundle at build time, so set it before `next build`. Local ports differ from the defaults on purpose: Postgres 5433, Redis 6380, MinIO 9100, Gotenberg 3100.

Never put real secrets in the example files or in git. In production, pass them through your host environment or a secrets manager.

### Core

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL connection string. In production add `connection_limit` so all API processes stay under Postgres `max_connections` (at least 10). | `postgresql://botss:botss@localhost:5433/botss?schema=public` |
| `REDIS_URL` | Required | Redis for cache, queues, presence. | `redis://localhost:6380` |
| `PUBLIC_APP_URL` | Required | Public web URL, used to build invitation and reset links. No trailing slash. | `https://app.example.com` |
| `BETTER_AUTH_SECRET` | Required | Secret for sessions. | output of `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Required | Public URL of the API as browsers see it. Use HTTPS in production so cookies can be Secure. | `https://api.example.com` |
| `AUTH_COOKIE_DOMAIN` | Optional | Parent domain for the session cookie when API and web are on different subdomains. Leave blank locally. | `.example.com` |
| `AUTH_COOKIE_PREFIX` | Optional | Session cookie name prefix. Leave blank in production (changing it signs everyone out). Set it for a staging install on the same parent domain. | `iwm-staging` |
| `API_PORT` | Optional | Port the API listens on. | `4000` |
| `API_BASE_PATH` | Optional | URL prefix for all API routes. | `/api/v1` |
| `WEB_ORIGIN` | Required | Comma-separated origins allowed to make credentialed requests (CORS). | `http://localhost:3000` |
| `LOG_LEVEL` | Optional | Minimum log level: `verbose`, `debug`, `log`, `warn`, `error`, `fatal`. Blank means debug in development and log in production. | `warn` |
| `ADMIN_EMAIL` | Optional | Address of the primary admin. The admin panel refuses to demote or delete it. Unset: no account is protected. | `admin@example.com` |
| `TRUST_PROXY_HOPS` | Optional | Number of reverse proxies in front of the API (Caddy is 1). Rate limits use the client IP, so this must be right. | `1` |
| `MAX_UPLOAD_BYTES` | Optional | Largest single upload in bytes (default 250 MB). | `262144000` |
| `CHAT_ATTACHMENT_URL_PREFIXES` | Optional | Extra URL prefixes accepted for chat attachments besides `S3_PUBLIC_URL` and `S3_ENDPOINT`, comma separated. Usually empty. | `https://cdn.example.com/` |
| `ROLE` | Optional | Process role: `all`, `api` or `worker`. Read from the real process environment only, not from `.env`. See [Process roles](#7-process-roles). | `worker` |
| `WORKER_HEALTH_PORT` | Optional | Health check port of a `worker` process (default 4100). Real process environment only. Not in `.env.example`. | `4100` |

### HR and payroll

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `HR_EMAIL_DOMAIN` | Optional | Turns on the daily timesheet warnings for the organization with this email domain; only users on this domain are scanned and notified. Unset: warnings off. | `example.com` |
| `HR_SENDER_EMAIL` | Optional | Existing user the timesheet warnings are sent from. Needed together with `HR_EMAIL_DOMAIN`. Unset: warnings off. | `hr@example.com` |
| `PAYSLIP_SIGNATORY_NAME` | Optional | Signatory printed on the root (platform) organization's own payslips. Other organizations never get it. Unset: no signatory block. | `Jane Doe` |
| `PAYSLIP_SIGNATORY_TITLE` | Optional | Signatory's title. Unset: blank. | `CEO` |
| `PAYSLIP_TEMPLATES_DIR` | Optional | Where the payslip template lives. Unset: `apps/api/payslip-templates/default`. | `/srv/iwm/payslip-templates` |

### Website lead intake

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `CHATBOT_INTAKE_SECRET` | Optional | HMAC secret your website signs with for `POST /api/v1/leads/external`. Blank disables the endpoint (it returns 503). | output of `openssl rand -hex 32` |
| `CHATBOT_INTAKE_WORKSPACE_ID` | Optional | Fixed workspace that receives the leads. Create a "Website Leads" workspace first. | `cm...` |
| `CHATBOT_INTAKE_USER_ID` | Optional | Fixed no-login bot user (member of that workspace) that creates the leads. | `cm...` |

### Web app

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Required | Where the browser reaches the API. In both `.env.example` and `apps/web/.env.example`. | `http://localhost:4000` |
| `NEXT_PUBLIC_API_BASE_PATH` | Required | API path prefix, same as `API_BASE_PATH`. In both files. | `/api/v1` |
| `NEXT_PUBLIC_WEB_URL` | Optional | Public origin of the web app, used for absolute OG and Twitter image URLs. | `https://app.example.com` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Optional | Browser Web Push public key. Must equal `VAPID_PUBLIC_KEY`. Lives in `apps/web/.env.example`, needed at build time. Blank disables closed-tab push. | `BN...` |
| `NEXT_PUBLIC_CPANEL_DOMAIN` | Optional | Domain cPanel-managed mailboxes live under, mirrors `CPANEL_DOMAIN`. Unset: no one is offered self-serve mailbox setup. In `apps/web/.env.example`. | `example.com` |
| `NEXT_PUBLIC_ADMIN_EMAIL` | Optional | Mirrors `ADMIN_EMAIL` so the users page shows that account as protected. Unset: none shown as protected. In `apps/web/.env.example`. | `admin@example.com` |
| `NEXT_PUBLIC_MAIL_DEFAULT_IMAP_HOST` | Optional | IMAP host pre-filled in the Add mail account form. Unset: empty field. In `apps/web/.env.example`. | `mail.example.com` |
| `NEXT_PUBLIC_MAIL_DEFAULT_SMTP_HOST` | Optional | SMTP host pre-filled in the Add mail account form. Unset: empty field. In `apps/web/.env.example`. | `mail.example.com` |

### System email (invitations, resets, invoices sent from the platform)

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `SMTP_HOST` | Optional | SMTP server for system email. When blank, only organizations with their own mail config can send; everything else is logged (fine for local dev). | `mail.example.com` |
| `SMTP_PORT` | Optional | SMTP port. | `587` |
| `SMTP_SECURE` | Optional | `true` for implicit TLS (port 465). | `false` |
| `SMTP_USER` | Optional | SMTP login. | `no-reply@example.com` |
| `SMTP_PASSWORD` | Optional | SMTP password. | (secret) |
| `MAIL_FROM` | Optional | From header for system email. Unset: `no-reply@localhost`. | `"IWM <no-reply@example.com>"` |
| `SMTP_SKIP_VERIFY` | Optional | `true` skips the SMTP check at boot. Use it when you know the credentials are wrong and do not want each restart to count as a failed login on your mail host. | `false` |

### User mail (IMAP/SMTP client)

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `MAIL_ENCRYPTION_KEY` | Required | 64 hex characters (32 bytes). Encrypts stored IMAP/SMTP passwords. Do not rotate on an install that has mail accounts. | `openssl rand -hex 32` |
| `MAIL_DEFAULT_IMAP_HOST` | Optional | IMAP host used when the server auto-provisions a mail account for a cPanel-managed user. Needs `MAIL_DEFAULT_SMTP_HOST` too. Unset: no auto-provisioning. | `mail.example.com` |
| `MAIL_DEFAULT_SMTP_HOST` | Optional | SMTP host for auto-provisioned mail accounts. Unset: no auto-provisioning. | `mail.example.com` |
| `MAIL_SYNC_BATCH` | Optional | Messages fetched per IMAP round trip. | `25` |
| `MAIL_INITIAL_SYNC_LIMIT` | Optional | Most messages imported per run (the rest continue in the background). | `200` |
| `MAIL_MAX_SOURCE_BYTES` | Optional | Above this size only a message's text parts are downloaded, not attachments. | `15728640` |
| `MAIL_SEND_CONCURRENCY` | Optional | Parallel outbound sends on the mail queue. | `5` |
| `MAIL_RELAY_HOST` | Optional | Send all outbound user mail through this SMTP relay instead of each account's own SMTP. Useful when a mail host rate-limits your server's IP. | `smtp-relay.brevo.com` |
| `MAIL_RELAY_PORT` | Optional | Relay port. | `587` |
| `MAIL_RELAY_SECURE` | Optional | `true` for implicit TLS. | `false` |
| `MAIL_RELAY_USER` | Optional | Relay login. | (relay user) |
| `MAIL_RELAY_PASSWORD` | Optional | Relay password. | (secret) |

### cPanel mailbox provisioning

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `CPANEL_HOST` | Optional | cPanel server hostname. Leave any cPanel var blank to disable the integration. | `cpanel.example.com` |
| `CPANEL_PORT` | Optional | cPanel UAPI port. | `2083` |
| `CPANEL_USER` | Optional | cPanel account that owns the domain (not an email address). | `myaccount` |
| `CPANEL_API_TOKEN` | Optional | API token with Email scope. | (secret) |
| `CPANEL_DOMAIN` | Optional | Domain the mailboxes live under. Unset: integration off. | `example.com` |

### Object storage (S3 compatible)

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `S3_ENDPOINT` | Required | S3 API endpoint (MinIO locally, R2 or S3 in production). | `http://localhost:9100` |
| `S3_REGION` | Required | Region name. Use `auto` for R2. | `us-east-1` |
| `S3_ACCESS_KEY_ID` | Required | Access key. | `botss-local` |
| `S3_SECRET_ACCESS_KEY` | Required | Secret key. | (secret) |
| `S3_BUCKET` | Required | Bucket for uploads. | `botss-files` |
| `S3_FORCE_PATH_STYLE` | Optional | `true` for MinIO and R2's raw S3 API. | `true` |
| `S3_PUBLIC_URL` | Optional | Public base URL for files. Leave unset locally; set to your CDN host in production. | `https://files.example.com` |
| `S3_PUBLIC_URL_INCLUDES_BUCKET` | Optional | `true` (default) builds `<host>/<bucket>/<key>`. `false` builds `<host>/<key>`, needed for a custom domain mapped to one R2 bucket. A wrong value shows up as files returning 404. | `false` |

### PDFs

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `GOTENBERG_URL` | Required for PDFs | Gotenberg service that renders invoice and payslip PDFs. | `http://127.0.0.1:3100` |
| `INVOICE_TEMPLATES_DIR` | Optional | Where invoice templates live. Defaults to `apps/api/invoice-templates`. | `/srv/iwm/invoice-templates` |

### Calls (LiveKit)

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `LIVEKIT_URL` | Optional | `ws://` or `wss://` endpoint clients connect to. | `wss://livekit.example.com` |
| `LIVEKIT_API_KEY` | Optional | Key; must match the LiveKit server's keys. | `devkey` |
| `LIVEKIT_API_SECRET` | Optional | Secret; must match the LiveKit server. | (secret) |

### Web Push

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `VAPID_SUBJECT` | Optional | Contact URL push services require. All three VAPID values must be set or push is disabled. | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` | Optional | Public key. Generate a pair with `npx web-push generate-vapid-keys`. | `BN...` |
| `VAPID_PRIVATE_KEY` | Optional | Private key. | (secret) |

### Placeholders for later phases

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `POLAR_ACCESS_TOKEN` | Optional | Reserved for Polar invoicing. Not used yet. | blank |
| `POLAR_WEBHOOK_SECRET` | Optional | Reserved for Polar webhooks. Not used yet. | blank |
| `TWILIO_ACCOUNT_SID` | Optional | Reserved for SMS and PSTN calls. Not used yet. | blank |
| `TWILIO_AUTH_TOKEN` | Optional | Reserved for Twilio. Not used yet. | blank |

### Desktop and mobile shells

Read by those apps, not by the API. Desktop values come from the process environment at run time; mobile values are inlined by the Expo bundler at build time (put them in `apps/mobile/.env`).

| Name | Required | What it does | Example |
| --- | --- | --- | --- |
| `BOTSS_APP_URL` | Optional | Web app the desktop window loads. Unset: `http://localhost:3000`. | `https://app.example.com` |
| `BOTSS_APP_EXTRA_ORIGINS` | Optional | Comma-separated extra origins that stay in the desktop window (for example an old domain). Unset: none. | `https://old.example.com` |
| `EXPO_PUBLIC_APP_URL` | Optional | Web app the mobile WebView loads. Unset: `http://localhost:3000` (simulator only; use your LAN address on a phone). | `https://app.example.com` |
| `EXPO_PUBLIC_APP_LEGACY_ORIGINS` | Optional | Comma-separated extra origins kept in the mobile WebView. Unset: none. | `https://old.example.com` |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Optional | Expo (EAS) project id for native push tokens. Unset: native push off. | `00000000-0000-0000-0000-000000000000` |

## 6. Optional services

IWM runs with only Postgres, Redis and object storage. Everything below is off until configured.

### Mail (IMAP/SMTP)

Users add their own mail accounts in the app (Settings, Mail). Set `MAIL_ENCRYPTION_KEY` (required) and optionally the `MAIL_DEFAULT_*_HOST` values. For system email (invitations, resets) set `SMTP_*` and `MAIL_FROM`. If your server's IP is rate-limited or port 25 is blocked (common on cloud hosts), send through a relay with `MAIL_RELAY_*` on port 587 or 465. Free options include Brevo (`smtp-relay.brevo.com:587`) and SMTP2GO (`mail.smtp2go.com:2525`), or Amazon SES SMTP. Add the relay's SPF and DKIM records for your domain. Mail receiving uses IMAP IDLE in the worker process.

### cPanel mailbox provisioning

If your mail runs on cPanel, set all five `CPANEL_*` vars, `MAIL_DEFAULT_IMAP_HOST` and `MAIL_DEFAULT_SMTP_HOST`, and `NEXT_PUBLIC_CPANEL_DOMAIN`. The admin Users panel can then create, rotate and import mailboxes. Without them the panel still works and does not touch the mail server.

### LiveKit calls

`docker compose up -d` starts a LiveKit server on ports 7880 (WebSocket), 7881 (TCP) and 7882 (UDP). Put the same key and secret in `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` before starting compose, and set `LIVEKIT_URL`. In production use a `wss://` URL, open the UDP port and consider LiveKit Cloud or a dedicated host.

### Gotenberg PDFs

Gotenberg renders invoices and payslips from HTML. The compose service runs headless Chromium with JavaScript disabled and only local files allowed, bound to `127.0.0.1:3100`. Point `GOTENBERG_URL` at it. Without it, PDF generation fails.

### Storage (MinIO, S3, R2)

Local development uses MinIO (console at http://localhost:9101). For S3 or Cloudflare R2 set the `S3_*` vars to your endpoint, bucket and keys, and set `S3_PUBLIC_URL` to the public or CDN host. Add your web origin to the bucket's CORS rules. Binaries are never stored in the database.

### Push notifications (Firebase and Expo)

- **Browser and desktop**: generate VAPID keys with `npx web-push generate-vapid-keys`, set the three `VAPID_*` vars on the API and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in `apps/web` before `next build`.
- **Mobile**: uses Expo push. Set `EXPO_PUBLIC_EAS_PROJECT_ID` to your Expo project id. For Android, copy `apps/mobile/google-services.example.json` to `apps/mobile/google-services.json` (git-ignored) and fill in your Firebase project. iOS needs your own Apple developer account and push credentials through EAS.

## 7. Process roles

The same API build runs in three modes, chosen by the `ROLE` environment variable.

| `ROLE` | What runs |
| --- | --- |
| `all` (default, also when unset) | One process does everything: HTTP and Socket.IO, BullMQ workers, IMAP IDLE, crons, boot-time backfills. |
| `api` | HTTP and Socket.IO only. It enqueues jobs but runs no workers, IMAP watcher or crons. |
| `worker` | BullMQ workers, IMAP IDLE, crons, backfills. No HTTP API. It serves only a health check on `WORKER_HEALTH_PORT` (default 4100). |

`ROLE` and `WORKER_HEALTH_PORT` are read from the real process environment (for example your PM2 or systemd config), never from `.env`, so a shared `.env` cannot flip a process. An invalid `ROLE` stops the boot.

When to split: keep `all` for development and small installs. Split when HTTP latency suffers from background work (large mail syncs, PDF renders, imports), or when you want to restart or scale the API without interrupting IMAP and jobs. Always run `api` and `worker` as a pair, and run exactly one process that does background work (`all` or `worker`), because the IMAP watcher and crons assume a single instance. Redis carries events between the two processes, so both must share the same `REDIS_URL`. For a second install on one host (staging), give its worker its own `WORKER_HEALTH_PORT`.

## 8. Desktop and mobile apps

Both are thin shells around the hosted web app. The desktop app adds a tray, deep links and system notifications. The mobile app adds native push and secure storage. The UI is loaded from your server at run time, so no web assets are bundled.

### Desktop (Electron)

- Dev: `pnpm --filter @botss/desktop dev` compiles and opens `http://localhost:3000`. Set `BOTSS_APP_URL` to point it at another server.
- Package: `pnpm --filter @botss/desktop build:win`, `build:linux` or `build:mac` writes an unsigned installer to `apps/desktop/release/` (NSIS, AppImage, dmg). `package` builds for the current OS. Signing and notarization are your job.
- Config is in `apps/desktop/electron-builder.yml`. Replace `appId: com.example.iwm`, `productName` and `copyright`.
- Auto-update: `electron-updater` is included but no feed is configured. Add a `publish:` entry (for example `provider: generic` with your own URL) to ship updates.
- On Windows, keep `appId` in sync with `app.setAppUserModelId(...)` in `apps/desktop/src/main.ts` (both `com.example.iwm`), or system notifications will not show.
- Icons: replace `apps/desktop/build/icon.ico`, `icon.icns` and a 512x512 `icon.png` (for example with `npx electron-icon-builder`). The files there are still the original deployment's logo.

### Mobile (Expo)

- Dev: `pnpm --filter @botss/mobile dev` (Expo SDK 52, React Native 0.76). Use `pnpm --filter @botss/mobile android` or `ios` for a native dev build.
- Set your web app URL with `EXPO_PUBLIC_APP_URL`, the Expo project id with `EXPO_PUBLIC_EAS_PROJECT_ID` (both in `apps/mobile/.env`), and the app ids in `apps/mobile/app.json` (`name`, `slug`, `ios.bundleIdentifier`, `android.package`, currently `com.example.iwm`).
- Icons and splash: replace the files in `apps/mobile/assets/` (`icon.png`, `adaptive-icon.png`, `splash-icon.png`). They are still the original deployment's logo.
- Build installable apps with EAS or `expo run:android` / `expo run:ios`.

## 9. Invoice and payslip templates

Each folder in `apps/api/invoice-templates/` is one invoice design: `template.html`, optional `styles.css`, `meta.json` and `assets/`. Copy `default/` to start your own. The payslip layout is in `apps/api/payslip-templates/default/` (`template.html`, `styles.css`, `logo.png`, `stamp.png`). Replace the placeholder logo and stamp, and set the signatory with `PAYSLIP_SIGNATORY_NAME` and `PAYSLIP_SIGNATORY_TITLE`. Logo, stamp and signatory appear only on the root (platform) organization's payslips. Templates reload when their files change. `pnpm test` validates them. Use `INVOICE_TEMPLATES_DIR` to keep templates outside the repo. PDFs are rendered by Gotenberg.

## 10. Common commands

```bash
pnpm dev                  # run all apps (add --filter=@botss/web or @botss/api for one)
pnpm build                # production builds
pnpm start                # run built apps (start:api, start:web for one)
pnpm typecheck            # tsc across packages
pnpm lint                 # eslint
pnpm test                 # package tests and the API check scripts
pnpm verify               # typecheck + lint + test
pnpm format               # prettier write (format:check to verify)
pnpm knip                 # find unused files, exports and dependencies

pnpm db:generate          # regenerate the Prisma client
pnpm db:migrate --name x  # prisma migrate dev
pnpm db:push              # push schema.prisma without a migration
pnpm db:seed:dev          # demo data (development only)
pnpm db:studio            # Prisma Studio
pnpm clean                # remove build output
```

## 11. Not included in this release

This is the first public release of software that grew inside one company's deployment. Some things were defined only in that deployment and are not part of this repository yet.

- **Migration history.** The repo ships `schema.prisma` but no migrations. `pnpm db:migrate --name init` creates the first migration from the schema. For a production database, review and commit that migration, then apply with `prisma migrate deploy`.
- **SQL-only database features.** Add them in a follow-up migration (`prisma migrate dev --create-only`, then edit the SQL):
  - triggers that protect the root organization and keep `SUPER_ADMIN` users inside it (the API enforces both rules too),
  - the partial unique index that allows one running timer per user,
  - the full-text search indexes (search works without them, just slower on large data; the trigram indexes are in `schema.prisma` and need `pg_trgm`),
  - the default payment-source rows (the API creates them on first use).
- **CI/CD.** No pipeline ships here. A good start is a workflow that runs `pnpm install --frozen-lockfile` then `pnpm verify` on each pull request, and a deploy job that builds, runs `prisma migrate deploy` and restarts the `api` and `worker` processes. Also run `gitleaks detect` to catch secrets.
- **Published images, Helm chart and setup screen** (see Planned above).

## 12. Security model

- **Tenant isolation.** Every request resolves the caller's organization and workspace scope, and services filter by it. Files are stored under a separate prefix per workspace. PostgreSQL row-level security as a second layer is planned.
- **Platform admins cannot read organization data.** `SUPER_ADMIN` users belong to the root platform organization. They manage organizations and see usage, but cannot read an organization's projects, chat, mail, files or money.
- **Support access with time-limited grants.** An organization admin can grant platform support a scoped, time-limited window into their organization, and revoke it at any time.
- **Audit log and platform log.** Each organization can read its own audit log, including support actions. Platform-level events go to a separate platform log.
- **Security alerts.** Bursts of failed sign-ins, mass deletes and very large imports or exports raise alerts in the affected organization's audit log and the platform log. Alerts carry counts and ids only, never content.
- **Permissions are enforced on the server** with NestJS guards and CASL. The frontend uses the same abilities only to hide what a user cannot do.
- **Secrets and sessions.** Secrets come from the environment. Mail credentials are encrypted at rest with `MAIL_ENCRYPTION_KEY`. The Devices page lists every session and can sign any of them out.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## 13. Known limitations

- **UI wording.** Some UI strings still say "Botss" (for example on the sign-in pages, in the logo alt text and in some admin and mail settings messages).
- **Package scope.** Packages use the `@botss/*` scope. Renaming is planned.
- **Deep link scheme.** The desktop and mobile apps use the `botss://` scheme (`apps/desktop/src/main.ts`, `apps/mobile/app.json`).
- **Internal root organization id.** The root platform organization id is the constant `ROOT_ORG_ID` (`org_root_thebotss`) in `apps/api/src/organizations/organizations.constants.ts` and the seed. It is an internal identifier only and is not shown to users.
- **Desktop and mobile icons.** The desktop icons (`apps/desktop/build/`) and the mobile icons and splash (`apps/mobile/assets/`) are still the original logo and must be replaced before you distribute a build. The web branding SVGs and the payslip `logo.png` and `stamp.png` are neutral placeholders.
- **macOS builds** are unsigned and not notarized.

## 14. Contributing, security reporting and license

- Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Run `pnpm verify` before opening a pull request.
- Security: report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for them.
- License: [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
