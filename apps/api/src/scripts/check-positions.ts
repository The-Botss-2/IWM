/**
 * Kanban / sprint reorder self-checks (no database): the reorder helpers
 * produce the same dense order the old per-row updates wrote, and the
 * single-statement rewrite is parameterised.
 *
 * Run: pnpm --filter @botss/api test
 */
import type { Prisma } from '@botss/database';

import { densePositions, insertAt, rewritePositions } from '../common/positions';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The pre-change algorithm, kept verbatim as the oracle. */
function oldOrder(siblings: string[], id: string, position: number): string[] {
  const targetIndex = Math.max(0, position);
  const at = Math.min(targetIndex, siblings.length);
  return [...siblings.slice(0, at), id, ...siblings.slice(at)];
}

async function main(): Promise<void> {
  const siblings = ['a', 'b', 'c', 'd'];
  for (const pos of [-3, 0, 1, 2, 4, 9]) {
    check(`insertAt matches the old order at ${pos}`, same(insertAt(siblings, 'x', pos), oldOrder(siblings, 'x', pos)));
  }
  check('insertAt into an empty column', same(insertAt([], 'x', 5), ['x']));
  check(
    'densePositions numbers from 0',
    same(densePositions(['p', 'q', 'r']), [
      { id: 'p', position: 0 },
      { id: 'q', position: 1 },
      { id: 'r', position: 2 },
    ]),
  );
  // Siblings keep the position they had in the full ordering when the
  // moving task is written separately.
  const ordered = insertAt(siblings, 'x', 2);
  const rest = densePositions(ordered).filter((r) => r.id !== 'x');
  check(
    'siblings after the moving card shift by one',
    same(rest, [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 3 },
      { id: 'd', position: 4 },
    ]),
  );

  const captured: Prisma.Sql[] = [];
  const db = {
    $executeRaw(q: Prisma.Sql) {
      captured.push(q);
      return Promise.resolve(0) as Prisma.PrismaPromise<number>;
    },
  };
  await rewritePositions(db, 'Task', [], { touchUpdatedAt: true });
  check('no statement for an empty list', captured.length === 0);
  await rewritePositions(db, 'Task', rest, { touchUpdatedAt: true });
  await rewritePositions(db, 'SprintTask', densePositions(['s1', 's2']));
  check('one statement per call', captured.length === 2);
  const [task, sprint] = captured;
  check('task rewrite targets "Task" and stamps updatedAt', !!task && /UPDATE "Task"/.test(task.sql) && /"updatedAt"/.test(task.sql), task?.sql);
  check('sprint rewrite targets "SprintTask" without updatedAt', !!sprint && /UPDATE "SprintTask"/.test(sprint.sql) && !/updatedAt/.test(sprint.sql), sprint?.sql);
  check(
    'ids and positions are bound parameters',
    !!task && same(task.values, [['a', 'b', 'c', 'd'], [0, 1, 3, 4]]),
    JSON.stringify(task?.values),
  );

  if (failures > 0) {
    console.error(`\n${failures} position check(s) failed.`);
    process.exit(1);
  }
  console.log('position checks passed.');
}

void main();
