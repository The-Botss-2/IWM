import { PrismaClient } from '@prisma/client';

import { withSoftDelete } from './soft-delete.js';

declare global {
  // Cached on globalThis to survive Next.js HMR and tsx watch reloads in dev.
  // eslint-disable-next-line no-var
  var __botss_prisma__: PrismaClient | undefined;
}

const isDev = process.env.NODE_ENV !== 'production';

const baseClient: PrismaClient =
  globalThis.__botss_prisma__ ??
  new PrismaClient({
    log: isDev ? ['error', 'warn'] : ['error'],
  });

if (isDev) {
  globalThis.__botss_prisma__ = baseClient;
}

/** Raw PrismaClient without the soft-delete extension. Use only for migrations and admin tooling. */
export const rawPrisma = baseClient;

/** Default Prisma client with the soft-delete extension applied. Use this everywhere. */
export const prisma = withSoftDelete(baseClient);

// Re-export everything from @prisma/client so consumers import enums + types from
// `@botss/database` (e.g. `import { TaskStatus, type User } from '@botss/database'`).
export { setSoftDeleteListener, type SoftDeleteEvent } from './soft-delete.js';
export * from '@prisma/client';
