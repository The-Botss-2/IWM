import { Prisma } from '@botss/database';

/**
 * Place `item` at `index` among `siblings` (which must not contain it),
 * clamping the index to [0, siblings.length]. Pure; the result's array index
 * is each row's new dense position.
 */
export function insertAt<T>(siblings: readonly T[], item: T, index: number): T[] {
  const at = Math.min(Math.max(0, index), siblings.length);
  return [...siblings.slice(0, at), item, ...siblings.slice(at)];
}

/** `{ id, position }` for every row of an ordered list, positions dense from 0. */
export function densePositions(
  orderedIds: readonly string[],
): Array<{ id: string; position: number }> {
  return orderedIds.map((id, position) => ({ id, position }));
}

/** Tables whose `position` column `rewritePositions` may renumber. */
const POSITION_TABLES = {
  Task: Prisma.raw('"Task"'),
  SprintTask: Prisma.raw('"SprintTask"'),
} as const;

type PositionTable = keyof typeof POSITION_TABLES;

/** The subset of a Prisma (transaction) client this needs. */
interface RawExecutor {
  $executeRaw(query: Prisma.Sql): Prisma.PrismaPromise<number>;
}

/**
 * Write each row's `position` in ONE statement
 * (`UPDATE ... FROM unnest(ids, positions)`), replacing one UPDATE per row.
 *
 * `touchUpdatedAt` stamps `updatedAt` (UTC, like Prisma's `@updatedAt`) on every
 * renumbered row, which the per-row `prisma.task.update` calls did implicitly.
 * Fully parameterised; the table name comes from a fixed allowlist.
 */
export async function rewritePositions(
  db: RawExecutor,
  table: PositionTable,
  rows: ReadonlyArray<{ id: string; position: number }>,
  opts: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const positions = rows.map((r) => r.position);
  const t = POSITION_TABLES[table];
  if (opts.touchUpdatedAt) {
    await db.$executeRaw(Prisma.sql`
      UPDATE ${t} AS t
         SET "position" = v.pos, "updatedAt" = (now() AT TIME ZONE 'UTC')
        FROM unnest(${ids}::text[], ${positions}::int[]) AS v(id, pos)
       WHERE t."id" = v.id`);
  } else {
    await db.$executeRaw(Prisma.sql`
      UPDATE ${t} AS t
         SET "position" = v.pos
        FROM unnest(${ids}::text[], ${positions}::int[]) AS v(id, pos)
       WHERE t."id" = v.id`);
  }
}
