/**
 * Which share of the work this API process does, from the `ROLE` env var.
 *
 *   - `all` (default, also when ROLE is unset): one process does everything,
 *     exactly as before roles existed: HTTP + Socket.IO, BullMQ workers,
 *     IMAP IDLE, crons and boot-time backfills.
 *   - `api`: HTTP + Socket.IO only. It still enqueues jobs, but registers no
 *     BullMQ worker, no IMAP IDLE watcher, no cron/interval and no boot
 *     backfill.
 *   - `worker`: BullMQ workers, IMAP IDLE, crons and boot backfills. No HTTP
 *     API; only a small health server on WORKER_HEALTH_PORT.
 *
 * `api` and `worker` only make sense as a pair. Run exactly one process that
 * does background work (`all` or `worker`): the IMAP IDLE watcher and the
 * crons assume a single instance. See "Process roles" in the README.
 *
 * ROLE is read from the real process environment (your process manager) before any .env file
 * is loaded, so a shared .env can never turn the worker into an API or back.
 */

export const PROCESS_ROLES = ['all', 'api', 'worker'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** Nest DI token carrying the resolved role (see ProcessRoleModule). */
export const PROCESS_ROLE = Symbol('PROCESS_ROLE');

export class InvalidProcessRoleError extends Error {
  constructor(raw: string) {
    super(
      `Invalid ROLE=${JSON.stringify(raw)}. Expected one of: ${PROCESS_ROLES.join(', ')} ` +
        '(unset means "all"). Fix the ROLE env var of this process and restart it.',
    );
    this.name = 'InvalidProcessRoleError';
  }
}

/** Parse a raw ROLE value. Unset or blank is `all`; anything unknown throws. */
export function parseProcessRole(raw: string | undefined): ProcessRole {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'all';
  if ((PROCESS_ROLES as readonly string[]).includes(value)) return value as ProcessRole;
  throw new InvalidProcessRoleError(raw ?? '');
}

let resolvedRole: ProcessRole | null = null;

/**
 * The role of this process, parsed once and cached. `main.ts` calls this
 * before loading .env files, which pins the value to the process environment and
 * fails the boot early on an invalid value.
 */
export function getProcessRole(): ProcessRole {
  if (resolvedRole === null) resolvedRole = parseProcessRole(process.env.ROLE);
  return resolvedRole;
}

/** Serves the HTTP API and Socket.IO. */
export function servesHttp(role: ProcessRole): boolean {
  return role !== 'worker';
}

/** Runs BullMQ workers, IMAP IDLE, crons/intervals and boot backfills. */
export function runsBackgroundWork(role: ProcessRole): boolean {
  return role !== 'api';
}

/**
 * Work is split across processes, so in-process events (notifications, mail
 * pushes, socket broadcasts) must also travel over Redis.
 */
export function isSplitRole(role: ProcessRole): boolean {
  return role !== 'all';
}

/** Options for `ScheduleModule.forRoot`: no @Cron/@Interval/@Timeout in `api`. */
export function scheduleOptionsForRole(role: ProcessRole): {
  cronJobs: boolean;
  intervals: boolean;
  timeouts: boolean;
} {
  const on = runsBackgroundWork(role);
  return { cronJobs: on, intervals: on, timeouts: on };
}

/**
 * `extraOptions` for `BullModule.forRoot*`. With `manualRegistration` the
 * BullMQ explorer never creates a Worker for any `@Processor`, so the `api`
 * role only produces jobs. Queues (producers) are unaffected.
 */
export function bullExtraOptionsForRole(role: ProcessRole): { manualRegistration: boolean } {
  return { manualRegistration: !runsBackgroundWork(role) };
}

/** One-line description for the boot log. */
export function describeProcessRole(role: ProcessRole): string {
  switch (role) {
    case 'all':
      return 'all (HTTP + Socket.IO + BullMQ workers + IMAP IDLE + crons in this one process)';
    case 'api':
      return 'api (HTTP + Socket.IO only; jobs are enqueued for the worker process)';
    case 'worker':
      return 'worker (BullMQ workers + IMAP IDLE + crons; no HTTP API)';
  }
}
