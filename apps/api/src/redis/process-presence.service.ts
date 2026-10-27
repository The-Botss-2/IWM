import { hostname } from 'node:os';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import IORedis from 'ioredis';

import { PROCESS_ROLE, type ProcessRole } from '../common/process-role';
import { RedisService } from './redis.service';

/**
 * Which API processes are alive, by role, in one Redis sorted set
 * (member `<role>:<host>:<pid>`, score = last heartbeat in ms).
 *
 * It exists for one guarantee: only ONE process runs the background
 * singletons (IMAP IDLE watchers, crons). An `all` process and a `worker`
 * must never run side by side, which is easy to cause by accident, e.g.
 * starting a new worker process while the API process still has no ROLE. So:
 *
 *   - a `worker` refuses to start while a live `all` process is registered
 *     (`waitForNoLiveAllProcess`, run before Nest boots);
 *   - a running `worker` that sees a live `all` process shuts itself down
 *     (SIGTERM, graceful);
 *   - an `all` process that finds a live `worker` at boot logs a loud error
 *     (it cannot refuse: it serves the website);
 *   - an `api` process with no live `worker` logs an error every 5 minutes.
 *
 * Brief overlaps of two processes of the SAME role during a rolling reload are
 * what happened before roles existed and are not flagged.
 */
export const PRESENCE_KEY = 'botss:process-roles';
export const PRESENCE_BEAT_MS = 5_000;
/** A member not refreshed for this long is treated as gone (crashed/killed). */
export const PRESENCE_STALE_MS = 15_000;
const REDIS_OP_TIMEOUT_MS = 2_000;
const NO_WORKER_WARN_EVERY_MS = 5 * 60_000;

export function presenceMember(
  role: ProcessRole,
  host: string = hostname(),
  pid: number = process.pid,
): string {
  return `${role}:${host}:${pid}`;
}

/** Members of `role` whose heartbeat is fresh at `now`. Pure. */
export function liveMembersWithRole(
  entries: ReadonlyArray<{ member: string; score: number }>,
  role: ProcessRole,
  now: number,
): string[] {
  return entries
    .filter((e) => e.member.startsWith(`${role}:`) && now - e.score < PRESENCE_STALE_MS)
    .map((e) => e.member);
}

/** ioredis `ZRANGE ... WITHSCORES` reply -> entries. */
function toEntries(flat: string[]): Array<{ member: string; score: number }> {
  const out: Array<{ member: string; score: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('redis timed out')), ms).unref()),
  ]);
}

@Injectable()
export class ProcessPresenceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProcessPresenceService.name);
  private readonly member: string;
  private timer: NodeJS.Timeout | null = null;
  /** The `all` role-conflict check runs once, after the first heartbeat lands. */
  private conflictChecked = false;
  /** Heartbeats that reached Redis. */
  private beats = 0;
  /** Set once the worker has asked itself to shut down. */
  private stopping = false;
  private lastNoWorkerWarnAt = 0;
  /** When the worker was first seen missing; reloads leave short gaps. */
  private noWorkerSince: number | null = null;

  constructor(
    private readonly redis: RedisService,
    @Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all',
  ) {
    this.member = presenceMember(role);
  }

  async onApplicationBootstrap(): Promise<void> {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), PRESENCE_BEAT_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await withTimeout(this.redis.client.zrem(PRESENCE_KEY, this.member), 500);
    } catch {
      // Best effort: the entry goes stale on its own.
    }
  }

  private async beat(): Promise<void> {
    const now = Date.now();
    try {
      const c = this.redis.client;
      // Don't pile commands into ioredis's offline queue during an outage.
      if (c.status !== 'ready') return;
      await withTimeout(
        c
          .multi()
          .zadd(PRESENCE_KEY, now, this.member)
          // Drop long-dead members so the set stays tiny.
          .zremrangebyscore(PRESENCE_KEY, '-inf', now - PRESENCE_STALE_MS * 20)
          .exec(),
        REDIS_OP_TIMEOUT_MS,
      );
    } catch {
      // Redis down: readiness reports it; nothing to add here.
      return;
    }
    this.beats += 1;
    switch (this.role) {
      case 'all':
        if (!this.conflictChecked) {
          this.conflictChecked = true;
          await this.warnOnConflict();
        }
        return;
      case 'worker':
        await this.stopIfAllProcessAppeared();
        return;
      case 'api':
        // Give a freshly (re)started worker a few beats to register first.
        if (this.beats >= 4) await this.warnIfNoWorker();
        return;
    }
  }

  private async liveMembers(role: ProcessRole): Promise<string[] | null> {
    try {
      const flat = await withTimeout(
        this.redis.client.zrange(PRESENCE_KEY, 0, -1, 'WITHSCORES'),
        REDIS_OP_TIMEOUT_MS,
      );
      return liveMembersWithRole(toEntries(flat), role, Date.now());
    } catch {
      // Redis down: nothing to compare against.
      return null;
    }
  }

  private async warnOnConflict(): Promise<void> {
    const workers = await this.liveMembers('worker');
    if (workers && workers.length > 0) {
      this.logger.error(
        `ROLE=all process started while a ROLE=worker process is alive (${workers.join(', ')}). ` +
          'IMAP IDLE and the crons now run twice. Either set ROLE=api on this app, or delete the ' +
          'worker process. See "Process roles" in the README.',
      );
    }
  }

  /**
   * The pre-boot guard only covers the worker's start. An `all` process that
   * comes up later (someone drops ROLE from the api app) would run every
   * background singleton twice, so the worker steps aside: SIGTERM goes
   * through Nest's shutdown hooks (enableShutdownHooks in worker-bootstrap),
   * and the process manager's restart then waits in the pre-boot guard.
   */
  private async stopIfAllProcessAppeared(): Promise<void> {
    if (this.stopping) return;
    const all = await this.liveMembers('all');
    if (!all || all.length === 0) return;
    this.stopping = true;
    this.logger.error(
      `A ROLE=all API process is alive (${all.join(', ')}) and already runs the BullMQ workers, ` +
        'IMAP IDLE and crons. This worker is shutting down so they do not run twice. Set ROLE=api ' +
        'on the API process, or stop this worker process. See "Process roles" in the README.',
    );
    process.kill(process.pid, 'SIGTERM');
  }

  /** An `api` process with no worker means jobs are only queued, never run. */
  private async warnIfNoWorker(): Promise<void> {
    const workers = await this.liveMembers('worker');
    if (workers === null) return;
    if (workers.length > 0) {
      this.noWorkerSince = null;
      return;
    }
    const now = Date.now();
    // A worker reload (kill_timeout plus boot) leaves a gap; only warn when
    // the worker has been missing for a full minute.
    this.noWorkerSince ??= now;
    if (now - this.noWorkerSince < 60_000) return;
    if (now - this.lastNoWorkerWarnAt < NO_WORKER_WARN_EVERY_MS) return;
    this.lastNoWorkerWarnAt = now;
    this.logger.error(
      'ROLE=api but no live ROLE=worker process is registered: jobs are queued but nothing runs ' +
        'them, and IMAP IDLE and the crons are stopped. Start a ROLE=worker process, or drop ROLE ' +
        'from this process. See "Process roles" in the README.',
    );
  }
}

/** The few ioredis calls the pre-boot guard makes. */
export interface PresenceReader {
  connect(): Promise<unknown>;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
  disconnect(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Worker pre-boot guard: wait (up to `maxWaitMs`) until no live `all`
 * process is registered. A just-replaced `all` process stays registered for
 * up to PRESENCE_STALE_MS, so a short wait covers a normal switch. Resolves
 * `{ ok: false }` when an `all` process is still alive or Redis is
 * unreachable; the caller exits and the process manager retries later.
 */
export async function waitForNoLiveAllProcess(
  redisUrl: string,
  opts: {
    maxWaitMs: number;
    pollMs: number;
    log: (message: string) => void;
    /** Test seam; defaults to a one-off ioredis connection. */
    createClient?: (url: string) => PresenceReader;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client: PresenceReader = opts.createClient
    ? opts.createClient(redisUrl)
    : new IORedis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 5_000,
      });
  client.on('error', () => undefined);
  try {
    try {
      await withTimeout(client.connect(), 6_000);
    } catch (err) {
      return { ok: false, reason: `Redis unreachable (${(err as Error)?.message ?? 'unknown'})` };
    }
    const deadline = Date.now() + opts.maxWaitMs;
    let announced = false;
    for (;;) {
      let live: string[];
      try {
        const flat = await withTimeout(
          client.zrange(PRESENCE_KEY, 0, -1, 'WITHSCORES'),
          REDIS_OP_TIMEOUT_MS,
        );
        live = liveMembersWithRole(toEntries(flat), 'all', Date.now());
      } catch (err) {
        return { ok: false, reason: `Redis read failed (${(err as Error)?.message ?? 'unknown'})` };
      }
      if (live.length === 0) return { ok: true };
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason:
            `a ROLE=all API process is still running (${live.join(', ')}). It already runs the ` +
            'BullMQ workers, IMAP IDLE and crons. Set ROLE=api on it first (see "Process roles" in the ' +
            'README), or stop this worker process.',
        };
      }
      if (!announced) {
        announced = true;
        opts.log(`Waiting for ROLE=all process(es) to stop: ${live.join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  } finally {
    client.disconnect();
  }
}
