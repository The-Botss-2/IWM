import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';

/**
 * Every IMAP login we make goes through here, keyed by mail host.
 *
 * The mail host (shared cPanel behind CSF/cPHulk) drops our IP when it sees
 * bursts of connections. When that happens every account times out at once,
 * and if each account retries on its own clock the retries land in lockstep
 * and keep the block alive. This class makes the whole API behave as one
 * polite client per host:
 *
 *   - Per-account backoff after a failed login (a wrong password jumps
 *     straight to the cap, it will not fix itself on retry).
 *   - A per-host circuit breaker. Consecutive connection failures across any
 *     accounts on the same host mean the host (or the path to it) is down,
 *     so we stop connecting entirely, then send one probe when the open
 *     window expires.
 *   - Login spacing: a bounded number of connects in flight per host and a
 *     minimum gap between connect starts, so a deploy or a recovery never
 *     sends 20 logins in the same second.
 *
 * All waits carry jitter so nothing we schedule lines up across accounts.
 */

const ACCOUNT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 600_000];
const HOST_OPEN_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/** Consecutive non-auth connect failures on one host that open its breaker. */
const HOST_TRIP_FAILURES = 3;
const MAX_CONCURRENT_CONNECTS = 2;
const CONNECT_GAP_MS = 750;
/** How long callers are told to wait while a half-open probe is running. */
const PROBE_WAIT_MS = 10_000;
const JITTER_RATIO = 0.2;

export interface GovernorEnv {
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): void;
  log(level: 'log' | 'warn', message: string): void;
}

/** DI token for a test clock. Unset in the app, which uses the real one. */
export const MAIL_GOVERNOR_ENV = Symbol('MAIL_GOVERNOR_ENV');

interface QueuedConnect {
  start: () => void;
  reject: (err: unknown) => void;
  probe: boolean;
}

/** Identity of one half-open probe, so a stale probe never clears a newer one. */
type ProbeToken = object;

interface HostState {
  /** Host-level connect failures since the host last answered. */
  consecutiveFailures: number;
  /** 0 = closed. Otherwise how many times in a row it has opened. */
  openStep: number;
  openUntil: number;
  probe: ProbeToken | null;
  inFlight: number;
  lastStartAt: number;
  queue: QueuedConnect[];
  timerArmed: boolean;
  /** Recent rejected logins on this host from `goodAccounts`: accountId -> when. */
  authFailures: Map<string, number>;
  /** Accounts that have logged in here successfully since their last reset. */
  goodAccounts: Set<string>;
}

interface AccountState {
  failures: number;
  nextAllowedAt: number;
}

/**
 * True only when the server itself rejected the credentials (a tagged NO or
 * BAD). imapflow sets `authenticationFailed` on ANY error during LOGIN,
 * including the socket dying mid-command, which is a connection failure and
 * must count toward the host breaker instead.
 */
export function isAuthFailure(err: unknown): boolean {
  const e = err as {
    authenticationFailed?: boolean;
    responseStatus?: string;
    responseText?: string;
    serverResponseCode?: string;
    message?: string;
  };
  // Dovecot answers `NO [UNAVAILABLE] Temporary authentication failure` when
  // its auth process is overloaded: a server problem, not the password.
  if (e?.serverResponseCode === 'UNAVAILABLE' || e?.serverResponseCode === 'LIMIT') return false;
  const rejected = e?.responseStatus === 'NO' || e?.responseStatus === 'BAD';
  if (e?.authenticationFailed === true) return rejected;
  return (
    rejected &&
    /AUTHENTICATIONFAILED|authentication failed|invalid credentials/i.test(
      `${e?.responseText ?? ''} ${e?.message ?? ''}`,
    )
  );
}

/**
 * Rejected logins from this many different accounts (each of which had
 * logged in fine before) within the window mean
 * the host is refusing us (cPHulk answers a blocked IP with a normal auth
 * failure), not that several people mistyped at once.
 */
const HOST_AUTH_TRIP_ACCOUNTS = 2;
const HOST_AUTH_WINDOW_MS = 5 * 60_000;

@Injectable()
export class MailHostGovernor {
  private readonly env: GovernorEnv;
  private readonly hosts = new Map<string, HostState>();
  private readonly accounts = new Map<string, AccountState>();

  constructor(@Optional() @Inject(MAIL_GOVERNOR_ENV) env?: GovernorEnv) {
    const logger = new Logger(MailHostGovernor.name);
    this.env = env ?? {
      now: () => Date.now(),
      random: () => Math.random(),
      setTimer: (fn, ms) => {
        setTimeout(fn, ms);
      },
      log: (level, message) => logger[level](message),
    };
  }

  /** `baseMs` scaled by a random factor in [0.8, 1.2]. */
  jitter(baseMs: number): number {
    return Math.round(baseMs * (1 - JITTER_RATIO + this.env.random() * 2 * JITTER_RATIO));
  }

  /**
   * Run `connectFn` (the IMAP login) once this host and account allow it.
   * Throws the `mail-server-backoff` 503 without touching the network while
   * the account is backing off or the host's breaker is open.
   */
  async connect<T>(host: string, accountId: string, connectFn: () => Promise<T>): Promise<T> {
    const key = host.trim().toLowerCase();
    const h = this.hostState(key);
    const accountWait = this.accountWaitMs(accountId);
    if (accountWait > 0) throw this.backoffError(accountWait);

    let probe: ProbeToken | null = null;
    if (h.openStep > 0) {
      const now = this.env.now();
      if (now < h.openUntil) throw this.backoffError(h.openUntil - now);
      if (h.probe) throw this.backoffError(PROBE_WAIT_MS);
      probe = {};
      h.probe = probe;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        h.queue.push({ start: resolve, reject, probe: probe !== null });
        this.pump(h);
      });
    } catch (err) {
      if (probe && h.probe === probe) h.probe = null;
      throw err;
    }

    try {
      const result = await connectFn();
      this.recordSuccess(key, h, accountId, probe);
      return result;
    } catch (err) {
      this.recordFailure(key, h, accountId, err, probe);
      throw err;
    } finally {
      h.inFlight--;
      this.pump(h);
    }
  }

  /**
   * Forget an account's backoff. Called when its credentials change, so a
   * fixed password is tried straight away instead of after the 10 min cap.
   */
  resetAccount(accountId: string): void {
    this.accounts.delete(accountId);
    for (const h of this.hosts.values()) {
      h.goodAccounts.delete(accountId);
      h.authFailures.delete(accountId);
    }
  }

  /**
   * How long before a connect for this account could go through, ignoring
   * login spacing. 0 when nothing is holding it back. Lets reconnect loops
   * sleep until the gate opens instead of polling a closed one.
   */
  msUntilAllowed(host: string, accountId: string): number {
    const h = this.hosts.get(host.trim().toLowerCase());
    let wait = this.accountWaitMs(accountId);
    if (h && h.openStep > 0) {
      const hostWait = h.probe
        ? Math.max(PROBE_WAIT_MS, h.openUntil - this.env.now())
        : h.openUntil - this.env.now();
      wait = Math.max(wait, hostWait);
    }
    return Math.max(0, wait);
  }

  private hostState(key: string): HostState {
    let h = this.hosts.get(key);
    if (!h) {
      h = {
        consecutiveFailures: 0,
        openStep: 0,
        openUntil: 0,
        probe: null,
        inFlight: 0,
        lastStartAt: Number.NEGATIVE_INFINITY,
        queue: [],
        timerArmed: false,
        authFailures: new Map(),
        goodAccounts: new Set(),
      };
      this.hosts.set(key, h);
    }
    return h;
  }

  private accountWaitMs(accountId: string): number {
    const state = this.accounts.get(accountId);
    return state ? state.nextAllowedAt - this.env.now() : 0;
  }

  /** Admit queued connects while a slot is free and the gap has passed. */
  private pump(h: HostState): void {
    while (h.queue.length > 0 && h.inFlight < MAX_CONCURRENT_CONNECTS) {
      const wait = h.lastStartAt + CONNECT_GAP_MS - this.env.now();
      if (wait > 0) {
        if (!h.timerArmed) {
          h.timerArmed = true;
          this.env.setTimer(() => {
            h.timerArmed = false;
            this.pump(h);
          }, wait);
        }
        return;
      }
      const next = h.queue.shift()!;
      // The breaker opened while this caller was queued. Only the probe may
      // still go out.
      if (h.openStep > 0 && !next.probe) {
        next.reject(this.backoffError(Math.max(PROBE_WAIT_MS, h.openUntil - this.env.now())));
        continue;
      }
      h.inFlight++;
      h.lastStartAt = this.env.now();
      next.start();
    }
  }

  private recordSuccess(
    key: string,
    h: HostState,
    accountId: string,
    probe: ProbeToken | null,
  ): void {
    this.accounts.delete(accountId);
    // The host just accepted a login, so the others it rejected were refused
    // for their own credentials. Stop counting them as known-good, or two
    // stale passwords re-open the breaker seconds after every close.
    for (const id of h.authFailures.keys()) {
      if (id !== accountId) h.goodAccounts.delete(id);
    }
    h.goodAccounts.add(accountId);
    // The host is accepting logins again, so earlier rejections were about
    // those accounts' passwords, not a block.
    h.authFailures.clear();
    this.hostReachable(key, h, probe);
  }

  private recordFailure(
    key: string,
    h: HostState,
    accountId: string,
    err: unknown,
    probe: ProbeToken | null,
  ): void {
    const authFailed = isAuthFailure(err);
    const now = this.env.now();

    // A rejected password still means the server answered: the host is up.
    // Unless several accounts whose passwords worked before are rejected at
    // once: that is the host refusing us (cPHulk), and more attempts only
    // extend the block. Accounts that never logged in do not count, or two
    // stale passwords would keep the whole host shut.
    if (authFailed && h.goodAccounts.has(accountId)) h.authFailures.set(accountId, now);
    // Only age the evidence while the breaker is closed. During a long block
    // the open windows outlast HOST_AUTH_WINDOW_MS, and pruning then would
    // let a failed probe close the breaker instead of escalating it. Any
    // successful login clears the evidence anyway.
    if (h.openStep === 0) {
      for (const [id, at] of h.authFailures) {
        if (now - at > HOST_AUTH_WINDOW_MS) h.authFailures.delete(id);
      }
    }
    const hostLevel = !authFailed || h.authFailures.size >= HOST_AUTH_TRIP_ACCOUNTS;

    // A real wrong password jumps to the cap: retrying will not fix it and
    // each attempt counts against our IP. A host-level failure backs off
    // step by step, and the breaker does the real gating.
    const prev = this.accounts.get(accountId)?.failures ?? 0;
    const failures = hostLevel ? prev + 1 : ACCOUNT_BACKOFF_MS.length;
    const delay = this.jitter(
      ACCOUNT_BACKOFF_MS[Math.min(failures, ACCOUNT_BACKOFF_MS.length) - 1]!,
    );
    this.accounts.set(accountId, { failures, nextAllowedAt: now + delay });
    this.env.log(
      'warn',
      `IMAP connect failed accountId=${accountId} host=${key} failures=${failures} backoffMs=${delay} message=${(err as Error)?.message ?? 'unknown'}`,
    );

    if (!hostLevel) {
      this.hostReachable(key, h, probe);
      return;
    }
    if (authFailed) {
      // The earlier rejections were the block too. Take those accounts off
      // the wrong-password cap so they come back as soon as the host does.
      for (const id of h.authFailures.keys()) {
        const state = this.accounts.get(id);
        if (!state) continue;
        const first = now + this.jitter(ACCOUNT_BACKOFF_MS[0]!);
        this.accounts.set(id, {
          failures: Math.min(state.failures, 1),
          nextAllowedAt: Math.min(state.nextAllowedAt, first),
        });
      }
    }

    h.consecutiveFailures++;
    if (probe && h.probe === probe) {
      // Our probe failed: the host is still unreachable, stay open longer.
      h.probe = null;
      this.openBreaker(key, h, h.openStep + 1, err);
    } else if (h.openStep === 0 && (h.consecutiveFailures >= HOST_TRIP_FAILURES || authFailed)) {
      this.openBreaker(key, h, 1, err);
    }
  }

  private hostReachable(key: string, h: HostState, probe: ProbeToken | null): void {
    if (probe && h.probe === probe) h.probe = null;
    h.consecutiveFailures = 0;
    if (h.openStep > 0) {
      h.openStep = 0;
      h.openUntil = 0;
      h.probe = null;
      this.env.log('log', `IMAP host circuit closed host=${key}`);
    }
  }

  private openBreaker(key: string, h: HostState, step: number, err: unknown): void {
    h.openStep = step;
    const openMs = this.jitter(HOST_OPEN_MS[Math.min(step, HOST_OPEN_MS.length) - 1]!);
    h.openUntil = this.env.now() + openMs;
    this.env.log(
      'warn',
      `IMAP host circuit open host=${key} step=${step} openMs=${openMs} failures=${h.consecutiveFailures} message=${(err as Error)?.message ?? 'unknown'}`,
    );
    // Everyone still waiting for a slot would only add to the pile.
    const waiting = h.queue.splice(0).filter((q) => {
      if (q.probe) return true;
      q.reject(this.backoffError(openMs));
      return false;
    });
    h.queue.push(...waiting);
  }

  private backoffError(waitMs: number): ServiceUnavailableException {
    return new ServiceUnavailableException({
      title: 'Mail server temporarily unreachable',
      status: 503,
      detail: `Retrying automatically in ${Math.ceil(waitMs / 1000)}s.`,
      code: 'mail-server-backoff',
    });
  }
}
