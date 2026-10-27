# Contributing to IWM

Thanks for helping. This guide covers setup, conventions and the checks to run
before you open a pull request.

## Setup

Follow the [Quick start](README.md#quick-start) in the README: `pnpm install`,
`docker compose up -d`, copy the `.env.example` files, `pnpm db:migrate --name init`,
`pnpm db:seed:dev`, `pnpm dev`.

Requirements: Node.js >= 22.12, pnpm >= 9, Docker.

## Workflow

1. Open an issue first for anything larger than a small fix, so the approach
   can be agreed before you write the code.
2. Fork the repository and create a branch from `main`:
   - `feat/<short-name>` for features
   - `fix/<short-name>` for bug fixes
   - `chore/<short-name>` for tooling, dependencies and clean-up
   - `docs/<short-name>` for documentation
3. Write commits in the [Conventional Commits](https://www.conventionalcommits.org/)
   style, e.g. `feat(tasks): add due-date filter` or `fix(chat): keep scroll position`.
4. Open a pull request against `main` with a clear description of what changed
   and how you tested it.

## Checks to run

Run these before you push; a pull request should pass all of them.

```bash
pnpm typecheck    # TypeScript strict mode across every package
pnpm lint         # eslint
pnpm test         # package tests and the API check scripts
# or all three:
pnpm verify
```

If you have [gitleaks](https://github.com/gitleaks/gitleaks) installed, also
run `gitleaks detect --source .` to make sure no secret slipped in. Never
commit `.env` files, keys or real customer data.

## Code rules

- **One schema.** The Prisma schema lives only in
  `packages/database/prisma/schema.prisma`. Never duplicate models elsewhere.
- **Typed boundaries.** Every API endpoint validates its input and output with
  a Zod schema from `packages/shared-types`. If a type is missing, add it
  there rather than inlining it.
- **One way to call the API.** Frontends never call `fetch` directly; they go
  through `packages/api-client`.
- **Server-side permissions.** Access rules are enforced in the API (NestJS
  guards and CASL abilities). Frontend checks only hide what a user cannot do.
- **Data conventions.** IDs are cuids, timestamps are UTC, user-facing entities
  are soft-deleted via `deletedAt`. Uploaded files go to object storage, never
  into the database.
- **TypeScript strict mode** everywhere. No `any` without an inline comment
  explaining why.
- **No business logic in UI components.** Put it in hooks, services or
  server-side handlers.
- API routes are versioned (`/api/v1/...`) and errors follow RFC 7807
  (Problem Details).
- For a new entity, change things in this order: database schema, then
  `shared-types`, then the API, then `api-client`, then the frontend.
- Prefer composition over inheritance and pure functions over classes outside
  NestJS.

## Tests

- API: the check scripts in `apps/api/src/scripts/check-*.ts` (run by
  `pnpm --filter @botss/api test`). Add or extend one for behaviour you change.
- Web: `apps/web/scripts/check-*.mjs` (run by `pnpm --filter @botss/web test`).
- Packages do not have tests yet; new ones should use Vitest.

## License

By contributing you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), the license of this project.
