/**
 * Per-user preferences (users/me/preferences) self-checks, no database: the
 * shared Zod schema strips unknown keys and rejects bad values, a stored
 * document is read leniently, PATCH merges per section, the service retries
 * concurrent writes and only ever touches the session user's row, and the
 * controller validates input and output.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@botss/database';
import {
  parseStoredUserPreferences,
  userPreferencesSchema,
  userPreferencesResponseSchema,
} from '@botss/shared-types';

import type { AuthedUser } from '../common/decorators/current-user.decorator';
import { SKIP_PERMISSIONS_KEY } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { PrismaService } from '../prisma/prisma.service';
import { UserPreferencesController } from '../users/user-preferences.controller';
import {
  mergeUserPreferences,
  UserPreferencesService,
} from '../users/user-preferences.service';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

/** Key-order-insensitive deep equality (stored JSON has no key order). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

interface Row {
  userId: string;
  data: Prisma.JsonValue;
  updatedAt: Date;
}

/** The slice of the userPreferences delegate the service uses, over a Map. */
class FakePreferencesDb {
  rows = new Map<string, Row>();
  /** Simulate another device writing between our read and our write. */
  interleave: Array<() => void> = [];
  /** Throw P2002 from the next create (a concurrent first save). */
  createRace: (() => void) | null = null;
  writes: string[] = [];

  findUnique(args: { where: { userId: string } }) {
    const row = this.rows.get(args.where.userId);
    const next = this.interleave.shift();
    const out = row ? { data: row.data, updatedAt: row.updatedAt } : null;
    next?.();
    return Promise.resolve(out);
  }

  create(args: { data: { userId: string; data: Prisma.JsonValue } }) {
    this.writes.push(args.data.userId);
    if (this.createRace) {
      this.createRace();
      this.createRace = null;
      return Promise.reject(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
    }
    const row: Row = { userId: args.data.userId, data: args.data.data, updatedAt: new Date() };
    this.rows.set(row.userId, row);
    return Promise.resolve({ data: row.data, updatedAt: row.updatedAt });
  }

  updateMany(args: {
    where: { userId: string; updatedAt: Date };
    data: { data: Prisma.JsonValue; updatedAt: Date };
  }) {
    this.writes.push(args.where.userId);
    const row = this.rows.get(args.where.userId);
    if (!row || row.updatedAt.getTime() !== args.where.updatedAt.getTime()) {
      return Promise.resolve({ count: 0 });
    }
    row.data = args.data.data;
    row.updatedAt = args.data.updatedAt;
    return Promise.resolve({ count: 1 });
  }
}

function makeService(db: FakePreferencesDb): UserPreferencesService {
  const prisma = { client: { userPreferences: db } } as unknown as PrismaService;
  return new UserPreferencesService(prisma);
}

const alice = { id: 'calice00000000000000000001' } as AuthedUser;
const bob = { id: 'cbob0000000000000000000001' } as AuthedUser;

async function main(): Promise<void> {
  // ---- Schema ----------------------------------------------------------
  const stripped = userPreferencesSchema.parse({
    appearance: { theme: 'dark', fontFamily: 'Comic Sans' },
    navigation: { hidden: ['leads'] },
    userId: bob.id,
    sneaky: { a: 1 },
  });
  check(
    'unknown keys are stripped at every level',
    same(stripped, { appearance: { theme: 'dark' }, navigation: { hidden: ['leads'] } }),
    JSON.stringify(stripped),
  );
  check('empty patch is valid', userPreferencesSchema.safeParse({}).success);
  check(
    'a single field is a valid patch',
    userPreferencesSchema.safeParse({ navigation: { panelCollapsed: true } }).success,
  );
  for (const bad of [
    { appearance: { theme: 'sepia' } },
    { appearance: { uiScale: 'xxl' } },
    { appearance: { gradientId: 'Not An Id!' } },
    { navigation: { layout: 'sidebar' } },
    { navigation: { panelCollapsed: 'yes' } },
    { navigation: { hidden: ['<script>'] } },
    { navigation: { hidden: Array.from({ length: 65 }, (_, i) => `id-${i}`) } },
  ]) {
    check(
      `rejects ${JSON.stringify(bad).slice(0, 60)}`,
      !userPreferencesSchema.safeParse(bad).success,
    );
  }

  // ---- Lenient stored read ----------------------------------------------
  check('null document reads as empty', same(parseStoredUserPreferences(null), {}));
  check('array document reads as empty', same(parseStoredUserPreferences([1, 2]), {}));
  const lenient = parseStoredUserPreferences({
    version: 1,
    appearance: { theme: 'sepia', gradientId: 'ocean', uiScale: 'lg', extra: true },
    navigation: { layout: 'rail', panelCollapsed: 'nope', hidden: ['leads', 'BAD ID', 3, 'leads', 'chat'] },
    other: 'x',
  });
  check(
    'stored read drops only the invalid values',
    same(lenient, {
      appearance: { gradientId: 'ocean', uiScale: 'lg' },
      navigation: { layout: 'rail', hidden: ['leads', 'chat'] },
    }),
    JSON.stringify(lenient),
  );
  check(
    'stored read output always satisfies the strict schema',
    userPreferencesSchema.safeParse(lenient).success,
  );

  // ---- Merge -------------------------------------------------------------
  const base = {
    appearance: { theme: 'dark' as const, gradientId: 'ocean' },
    navigation: { layout: 'rail' as const, hidden: ['leads', 'chat'] },
  };
  const baseCopy = JSON.parse(JSON.stringify(base)) as unknown;
  const merged = mergeUserPreferences(base, {
    appearance: { theme: 'light' },
    navigation: { hidden: ['mail'] },
  });
  check(
    'merge is per key within a section, arrays replace',
    same(merged, {
      appearance: { theme: 'light', gradientId: 'ocean' },
      navigation: { layout: 'rail', hidden: ['mail'] },
    }),
    JSON.stringify(merged),
  );
  check('merge does not mutate its input', same(base, baseCopy));
  check('empty patch keeps the document', same(mergeUserPreferences(base, {}), base));
  check(
    'hidden: [] resets the hidden list',
    same(mergeUserPreferences(base, { navigation: { hidden: [] } }).navigation?.hidden, []),
  );

  // ---- Service ------------------------------------------------------------
  {
    const db = new FakePreferencesDb();
    const svc = makeService(db);
    const empty = await svc.get(alice.id);
    check('never-saved user reads updatedAt null', empty.updatedAt === null);
    check('never-saved user reads empty preferences', same(empty.preferences, {}));
    check('response carries the version', empty.version === 1);

    const first = await svc.update(alice.id, { appearance: { theme: 'dark' } });
    check('first PATCH creates the row', db.rows.has(alice.id));
    check('first PATCH returns updatedAt', first.updatedAt instanceof Date);
    check(
      'stored document is versioned',
      (db.rows.get(alice.id)?.data as { version?: number }).version === 1,
    );

    const second = await svc.update(alice.id, { navigation: { layout: 'rail' } });
    check(
      'second PATCH merges with the first',
      same(second.preferences, { appearance: { theme: 'dark' }, navigation: { layout: 'rail' } }),
      JSON.stringify(second.preferences),
    );
    check(
      'updatedAt moves forward on every write',
      (second.updatedAt?.getTime() ?? 0) > (first.updatedAt?.getTime() ?? 0),
    );
    const reread = await svc.get(alice.id);
    check('GET returns what PATCH wrote', same(reread.preferences, second.preferences));
    check('another user still has nothing', (await svc.get(bob.id)).updatedAt === null);

    // A different device writes between our read and our conditional write:
    // the service must retry and keep both changes.
    db.interleave.push(() => {
      const row = db.rows.get(alice.id)!;
      row.data = {
        version: 1,
        appearance: { theme: 'dark', uiScale: 'xl' },
        navigation: { layout: 'rail' },
      };
      row.updatedAt = new Date(row.updatedAt.getTime() + 5);
    });
    const raced = await svc.update(alice.id, { appearance: { gradientId: 'ember' } });
    check(
      'a concurrent write is retried and both keys survive',
      same(raced.preferences.appearance, { theme: 'dark', uiScale: 'xl', gradientId: 'ember' }),
      JSON.stringify(raced.preferences),
    );

    // Persistent contention gives up with a 409 problem rather than looping.
    for (let i = 0; i < 10; i++) {
      db.interleave.push(() => {
        const row = db.rows.get(alice.id)!;
        row.updatedAt = new Date(row.updatedAt.getTime() + 5);
      });
    }
    let conflict: unknown = null;
    try {
      await svc.update(alice.id, { appearance: { theme: 'light' } });
    } catch (err) {
      conflict = err;
    }
    check('persistent contention answers 409', conflict instanceof ConflictException);
    if (conflict instanceof ConflictException) {
      const body = conflict.getResponse() as { status?: number; title?: string };
      check('409 body is a problem document', body.status === 409 && typeof body.title === 'string');
    }
    db.interleave = [];
  }

  {
    // Two devices make the very first save at once: create loses the race,
    // the service falls through to a merge onto the other device's row.
    const db = new FakePreferencesDb();
    const svc = makeService(db);
    db.createRace = () => {
      db.rows.set(bob.id, {
        userId: bob.id,
        data: { version: 1, navigation: { hidden: ['leads'] } },
        updatedAt: new Date(),
      });
    };
    const res = await svc.update(bob.id, { appearance: { theme: 'system' } });
    check(
      'first-save race merges onto the winner',
      same(res.preferences, { appearance: { theme: 'system' }, navigation: { hidden: ['leads'] } }),
      JSON.stringify(res.preferences),
    );
  }

  // ---- Controller -----------------------------------------------------------
  check(
    'routed at users/me/preferences',
    Reflect.getMetadata(PATH_METADATA, UserPreferencesController) === 'users/me/preferences',
  );
  check(
    'controller declares SkipPermissions (self-only resource)',
    Reflect.getMetadata(SKIP_PERMISSIONS_KEY, UserPreferencesController) === true,
  );
  check(
    'handlers take no id parameter',
    UserPreferencesController.prototype.get.length === 1 &&
      UserPreferencesController.prototype.update.length === 2,
  );

  {
    const db = new FakePreferencesDb();
    const controller = new UserPreferencesController(makeService(db));
    const pipe = new ZodValidationPipe(userPreferencesSchema);
    const body = pipe.transform({ appearance: { theme: 'dark' }, userId: bob.id });
    const out = await controller.update(alice, body);
    check('controller output satisfies the response schema', userPreferencesResponseSchema.safeParse(out).success);
    check(
      'writes land on the session user only, whatever the body says',
      same(db.writes, [alice.id]) && !db.rows.has(bob.id),
      JSON.stringify(db.writes),
    );
    const got = await controller.get(alice);
    check('controller GET round-trips', same(got.preferences, { appearance: { theme: 'dark' } }));

    let rejected: unknown = null;
    try {
      pipe.transform({ appearance: { theme: 'neon' } });
    } catch (err) {
      rejected = err;
    }
    check('invalid input is a 400', rejected instanceof BadRequestException);
    if (rejected instanceof BadRequestException) {
      const problem = rejected.getResponse() as { status?: number; code?: string };
      check('400 is a validation problem', problem.status === 400 && problem.code === 'validation_failed');
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} user-preferences check(s) failed`);
    process.exit(1);
  }
  console.log('user-preferences: all checks passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
