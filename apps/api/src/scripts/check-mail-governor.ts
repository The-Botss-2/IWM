/**
 * Mail host governor self-checks. No network, database or Redis: a fake
 * clock drives every timer, and "logins" are promises the test settles.
 *
 * 1. Jitter stays within +-20% of the base.
 * 2. Three connection failures open the host breaker; later callers fail
 *    fast without logging in, including ones already queued.
 * 3. After the open window exactly one probe goes out. Success closes the
 *    breaker; failure reopens it at the next, longer step.
 * 4. One wrong password backs off only that account. Rejections of two
 *    accounts that had logged in before (a cPHulk block) open the host
 *    breaker; stale passwords on accounts that never did never trip it. A
 *    temporary auth failure is not a wrong password, and a socket dropped
 *    during LOGIN counts as a connection failure.
 * 5. Login spacing: at most 2 connects in flight, >= 750 ms between starts.
 *
 * Run: pnpm --filter @botss/api test (chained after the portal check).
 */
import 'reflect-metadata';

import { MailHostGovernor, type GovernorEnv } from '../mail/mail-host-governor';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

class FakeEnv implements GovernorEnv {
  time = 0;
  rand = 0.5;
  logs: string[] = [];
  private timers: Array<{ at: number; fn: () => void }> = [];

  now(): number {
    return this.time;
  }
  random(): number {
    return this.rand;
  }
  setTimer(fn: () => void, ms: number): void {
    this.timers.push({ at: this.time + ms, fn });
  }
  log(_level: 'log' | 'warn', message: string): void {
    this.logs.push(message);
  }

  /** Move the clock forward, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    // Settle anything the test just triggered at the current time first.
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.time = next.at;
      next.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

/** Let every pending promise continuation run (the fake clock stays put). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Login {
  started: boolean;
  settle(ok: boolean, err?: Error): void;
}

/** A controllable login: `connectFn` for the governor plus its settle handle. */
function login(): { fn: () => Promise<string>; handle: Login } {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const handle: Login = {
    started: false,
    settle(ok, err) {
      if (ok) resolve('client');
      else reject(err ?? Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    },
  };
  const fn = () => {
    handle.started = true;
    return new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return { fn, handle };
}

function isBackoff(err: unknown): boolean {
  const res = (err as { getResponse?: () => unknown })?.getResponse?.() as
    | { code?: string }
    | undefined;
  return res?.code === 'mail-server-backoff';
}

async function settled<T>(p: Promise<T>): Promise<{ ok: boolean; err?: unknown }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

const HOST = 'mail.example.com';

async function jitterBounds(): Promise<void> {
  console.log('jitter');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  env.rand = 0;
  check('low end is 80%', g.jitter(10_000) === 8_000);
  env.rand = 0.999999;
  check('high end is 120%', g.jitter(10_000) <= 12_000 && g.jitter(10_000) >= 11_999);
}

async function breakerTripsAndProbes(): Promise<void> {
  console.log('host circuit breaker');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);

  // Three accounts time out; a fourth is queued behind the 2-slot limit.
  const logins = ['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, ...login() }));
  const results = logins.map((l) => settled(g.connect(HOST, l.id, l.fn)));
  await env.advance(1_000);
  check('two connects in flight, the rest queued', logins.filter((l) => l.handle.started).length === 2);
  logins[0]!.handle.settle(false);
  logins[1]!.handle.settle(false);
  await env.advance(2_000);
  check('third starts after a slot frees', logins[2]!.handle.started);
  check('fourth starts too (gap passed, slot free)', logins[3]!.handle.started);
  logins[2]!.handle.settle(false);
  await flush();
  check(
    'breaker opened after 3 failures',
    env.logs.some((m) => m.startsWith('IMAP host circuit open')),
  );
  logins[3]!.handle.settle(false);
  const outcomes = await Promise.all(results);
  check('all four failed', outcomes.every((o) => !o.ok));

  const blocked = login();
  const r = await settled(g.connect(HOST, 'a5', blocked.fn));
  check('new account fails fast while open', !r.ok && isBackoff(r.err) && !blocked.handle.started);
  check('msUntilAllowed reports the open window', g.msUntilAllowed(HOST, 'a5') > 0);

  // Open window is 30 s +-20%. Past it, one probe goes out, others wait.
  await env.advance(40_000);
  const probe = login();
  const probeResult = settled(g.connect(HOST, 'a6', probe.fn));
  await env.advance(0);
  check('probe starts after the window', probe.handle.started);
  const second = login();
  const secondResult = await settled(g.connect(HOST, 'a7', second.fn));
  check(
    'second caller fails fast during the probe',
    !secondResult.ok && isBackoff(secondResult.err) && !second.handle.started,
  );

  // Probe fails: reopen at step 2 (60 s +-20%), so 40 s later still closed.
  probe.handle.settle(false);
  await probeResult;
  check('failed probe reopens at step 2', env.logs.some((m) => m.includes('step=2')));
  await env.advance(40_000);
  const early = login();
  const earlyResult = await settled(g.connect(HOST, 'a8', early.fn));
  check('still open 40 s into step 2', !earlyResult.ok && !early.handle.started);

  // Past step 2: the next probe succeeds and closes the breaker.
  await env.advance(40_000);
  const probe2 = login();
  const probe2Result = settled(g.connect(HOST, 'a9', probe2.fn));
  await env.advance(0);
  probe2.handle.settle(true);
  check('successful probe connects', (await probe2Result).ok);
  check('breaker closed', env.logs.some((m) => m.startsWith('IMAP host circuit closed')));
  const after = login();
  const afterResult = settled(g.connect(HOST, 'a10', after.fn));
  await env.advance(1_000);
  after.handle.settle(true);
  check('normal connects resume', (await afterResult).ok);
}

async function queuedCallersRejectedWhenOpen(): Promise<void> {
  console.log('queued callers');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  // Two in flight, three more queued. The in-flight pair plus one more fail.
  const logins = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => ({ id, ...login() }));
  const results = logins.map((l) => settled(g.connect(HOST, l.id, l.fn)));
  await env.advance(1_000);
  logins[0]!.handle.settle(false);
  logins[1]!.handle.settle(false);
  // q3 starts at 1.5 s and q4 at 2.25 s; q5 waits for a free slot.
  await env.advance(2_000);
  check('q4 in flight when the breaker trips', logins[3]!.handle.started);
  logins[2]!.handle.settle(false);
  await flush();
  logins[3]!.handle.settle(false);
  const outcomes = await Promise.all(results);
  check('queued caller never logged in once open', !logins[4]!.handle.started);
  check('queued caller got the backoff error', !outcomes[4]!.ok && isBackoff(outcomes[4]!.err));
}

/** What imapflow throws when the server answers LOGIN with a tagged NO. */
function rejectedLogin(): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    responseStatus: 'NO',
    responseText: 'AUTHENTICATIONFAILED',
  });
}

/** What imapflow throws when the socket dies during LOGIN. */
function droppedLogin(): Error {
  return Object.assign(new Error('Connection not available'), {
    authenticationFailed: true,
    code: 'NoConnection',
  });
}

async function failLogin(
  env: FakeEnv,
  g: MailHostGovernor,
  accountId: string,
  err: Error,
): Promise<void> {
  const l = login();
  const p = settled(g.connect(HOST, accountId, l.fn));
  await env.advance(1_000);
  l.handle.settle(false, err);
  await p;
}

const opened = (env: FakeEnv) => env.logs.some((m) => m.startsWith('IMAP host circuit open'));

async function authFailureIsPerAccount(): Promise<void> {
  console.log('auth failures');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  await failLogin(env, g, 'bad', rejectedLogin());
  check('one rejected password leaves the host closed', !opened(env));
  const again = login();
  const againResult = await settled(g.connect(HOST, 'bad', again.fn));
  check('bad account backs off', !againResult.ok && !again.handle.started);
  check('bad account jumps to the 10 min cap', g.msUntilAllowed(HOST, 'bad') >= 480_000);
  const other = login();
  const otherResult = settled(g.connect(HOST, 'good', other.fn));
  await env.advance(1_000);
  other.handle.settle(true);
  check('other accounts unaffected', (await otherResult).ok);
  g.resetAccount('bad');
  check('resetAccount clears the backoff', g.msUntilAllowed(HOST, 'bad') === 0);
}

async function succeedLogin(env: FakeEnv, g: MailHostGovernor, accountId: string): Promise<void> {
  const l = login();
  const p = settled(g.connect(HOST, accountId, l.fn));
  await env.advance(1_000);
  l.handle.settle(true);
  await p;
}

async function hostRejectingEveryone(): Promise<void> {
  console.log('host rejecting every login (cPHulk block)');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  await succeedLogin(env, g, 'r1');
  await succeedLogin(env, g, 'r2');
  await failLogin(env, g, 'r1', rejectedLogin());
  check('one known-good account rejected: host still closed', !opened(env));
  await failLogin(env, g, 'r2', rejectedLogin());
  check('two known-good accounts rejected open the breaker', opened(env));
  check('rejected accounts leave the wrong-password cap', g.msUntilAllowed(HOST, 'r1') < 480_000);
  const next = login();
  const nextResult = await settled(g.connect(HOST, 'r3', next.fn));
  check('third account does not log in', !nextResult.ok && !next.handle.started);
}

async function longBlockKeepsEscalating(): Promise<void> {
  console.log('long cPHulk block');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  await succeedLogin(env, g, 'r1');
  await succeedLogin(env, g, 'r2');
  await failLogin(env, g, 'r1', rejectedLogin());
  await failLogin(env, g, 'r2', rejectedLogin());
  // The same account wins every probe; the other's rejection ages past 5 min.
  for (let i = 0; i < 5; i++) {
    await env.advance(g.msUntilAllowed(HOST, 'r1') + 1_000);
    await failLogin(env, g, 'r1', rejectedLogin());
  }
  check('escalates to step 5', env.logs.some((m) => m.includes('step=5')));
  check(
    'never closes while the host keeps rejecting',
    !env.logs.some((m) => m.startsWith('IMAP host circuit closed')),
  );
}

async function stalePasswordsOnceGoodDoNotRetrip(): Promise<void> {
  console.log('passwords changed in webmail on two known-good accounts');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  await succeedLogin(env, g, 'r1');
  await succeedLogin(env, g, 'r2');
  await succeedLogin(env, g, 'r3');
  await failLogin(env, g, 'r1', rejectedLogin());
  await failLogin(env, g, 'r2', rejectedLogin());
  check('breaker opens on the first pair', opened(env));
  // r3 wins the probe: the host is fine, r1 and r2 just have old passwords.
  await env.advance(g.msUntilAllowed(HOST, 'r3') + 1_000);
  await succeedLogin(env, g, 'r3');
  check('probe success closes it', env.logs.some((m) => m.startsWith('IMAP host circuit closed')));
  const opensBefore = env.logs.filter((m) => m.startsWith('IMAP host circuit open')).length;
  await env.advance(Math.max(g.msUntilAllowed(HOST, 'r1'), g.msUntilAllowed(HOST, 'r2')) + 1_000);
  await failLogin(env, g, 'r1', rejectedLogin());
  await failLogin(env, g, 'r2', rejectedLogin());
  const opensAfter = env.logs.filter((m) => m.startsWith('IMAP host circuit open')).length;
  check('no second trip', opensAfter === opensBefore);
  check('r1 now on the wrong-password cap', g.msUntilAllowed(HOST, 'r1') >= 480_000);
}

async function stalePasswordsNeverTripHost(): Promise<void> {
  console.log('stale passwords on accounts that never logged in');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  for (let round = 0; round < 3; round++) {
    await failLogin(env, g, 'stale1', rejectedLogin());
    await failLogin(env, g, 'stale2', rejectedLogin());
    await env.advance(13 * 60_000);
  }
  check('host breaker never opens', !opened(env));
}

async function temporaryAuthFailure(): Promise<void> {
  console.log('temporary authentication failure');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  const temp = Object.assign(new Error('Temporary authentication failure'), {
    authenticationFailed: true,
    responseStatus: 'NO',
    serverResponseCode: 'UNAVAILABLE',
  });
  await failLogin(env, g, 't1', temp);
  check('not treated as a wrong password', g.msUntilAllowed(HOST, 't1') < 480_000);
}

async function dropDuringLoginIsHostFailure(): Promise<void> {
  console.log('connection dropped during LOGIN');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  await failLogin(env, g, 'd1', droppedLogin());
  await failLogin(env, g, 'd2', droppedLogin());
  check('not yet open after 2 drops', !opened(env));
  check('a drop is not a wrong password', g.msUntilAllowed(HOST, 'd1') < 480_000);
  await failLogin(env, g, 'd3', droppedLogin());
  check('3 drops open the breaker', opened(env));
}

async function loginSpacing(): Promise<void> {
  console.log('login spacing');
  const env = new FakeEnv();
  const g = new MailHostGovernor(env);
  const starts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const results: Promise<unknown>[] = [];
  for (let i = 0; i < 6; i++) {
    results.push(
      g.connect(HOST, `s${i}`, async () => {
        starts.push(env.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Each login takes 2 s of fake time.
        await new Promise<void>((res) => env.setTimer(res, 2_000));
        inFlight--;
        return 'client';
      }),
    );
  }
  await env.advance(30_000);
  await Promise.all(results);
  check('all six connected', starts.length === 6);
  check('never more than 2 in flight', maxInFlight <= 2, `max=${maxInFlight}`);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  check('starts at least 750 ms apart', gaps.every((gap) => gap >= 750), gaps.join(','));
}

async function main(): Promise<void> {
  await jitterBounds();
  await breakerTripsAndProbes();
  await queuedCallersRejectedWhenOpen();
  await authFailureIsPerAccount();
  await hostRejectingEveryone();
  await longBlockKeepsEscalating();
  await stalePasswordsOnceGoodDoNotRetrip();
  await stalePasswordsNeverTripHost();
  await temporaryAuthFailure();
  await dropDuringLoginIsHostFailure();
  await loginSpacing();
  if (failures > 0) {
    console.error(`\n${failures} mail governor check(s) failed`);
    process.exit(1);
  }
  console.log('\nmail governor checks passed');
}

void main();
