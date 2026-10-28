/**
 * Session-cookie compatibility check for Better Auth upgrades.
 *
 * Production users must stay signed in across a Better Auth bump, so this
 * builds the real `createAuth` config against an in-memory stand-in for
 * Prisma (no database, Redis or network) and checks:
 *
 * 1. A session cookie signed the way Better Auth 1.1.x (better-call 0.3.x)
 *    signed it still resolves to its session, with the default cookie name
 *    and with a staging `AUTH_COOKIE_PREFIX`.
 * 2. A forged signature, an unknown token and an expired row are refused.
 * 3. Sign-in issues the same cookie name and value format (`<token>.<HMAC>`),
 *    still verifiable by the 1.1.x algorithm (so a rollback keeps sessions),
 *    with the 30-day Max-Age, SameSite=None, Secure, HttpOnly and the shared
 *    parent Domain; "Remember me" off gives a browser-session cookie.
 * 4. A day-old session slides its expiry forward; sign-out deletes the row.
 * 5. `onSignInFailed` fires once for a wrong password or an unknown email
 *    (the reply is still 401) and not at all for a successful sign-in.
 *
 * Run: pnpm --filter @botss/api test.
 */
import { webcrypto } from 'node:crypto';

import { type AppAuth, createAuth, hashPassword } from '@botss/auth';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// In-memory Prisma stand-in: just enough of the delegate API for the Better
// Auth Prisma adapter (findFirst/findMany/create/update/delete + where ops).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function same(a: unknown, b: unknown, insensitive: boolean): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (insensitive && typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const op = cond as Row;
      const ci = op.mode === 'insensitive';
      if ('equals' in op && !same(value, op.equals, ci)) return false;
      if ('in' in op && !(op.in as unknown[]).some((v) => same(value, v, ci))) return false;
      if ('notIn' in op && (op.notIn as unknown[]).some((v) => same(value, v, ci))) return false;
      if ('not' in op) {
        const not = op.not;
        if (not !== null && typeof not === 'object' && !(not instanceof Date) && 'equals' in not) {
          if (same(value, (not as Row).equals, ci)) return false;
        } else if (same(value, not, ci)) return false;
      }
      if ('lt' in op && !(compare(value, op.lt) < 0)) return false;
      if ('lte' in op && !(compare(value, op.lte) <= 0)) return false;
      if ('gt' in op && !(compare(value, op.gt) > 0)) return false;
      if ('gte' in op && !(compare(value, op.gte) >= 0)) return false;
      continue;
    }
    if (!same(value, cond, false)) return false;
  }
  return true;
}

function pick(row: Row | undefined, select: Row | undefined): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on === true) out[k] = row[k];
  return out;
}

let idSeq = 0;

function delegate(rows: Row[]) {
  const find = (where?: Row) => rows.filter((r) => matches(r, where));
  return {
    rows,
    async findFirst(args: { where?: Row; select?: Row } = {}) {
      return pick(find(args.where)[0], args.select);
    },
    async findUnique(args: { where?: Row; select?: Row } = {}) {
      return pick(find(args.where)[0], args.select);
    },
    async findMany(args: { where?: Row; select?: Row; take?: number; skip?: number } = {}) {
      const skip = args.skip ?? 0;
      return find(args.where)
        .slice(skip, args.take ? skip + args.take : undefined)
        .map((r) => pick(r, args.select) as Row);
    },
    async count(args: { where?: Row } = {}) {
      return find(args.where).length;
    },
    async create(args: { data: Row; select?: Row }) {
      const now = new Date();
      const row: Row = {
        id: `c${(idSeq += 1).toString().padStart(24, '0')}`,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      rows.push(row);
      return pick(row, args.select);
    },
    async update(args: { where: Row; data: Row }) {
      const row = find(args.where)[0];
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    },
    async updateMany(args: { where?: Row; data: Row }) {
      const hit = find(args.where);
      for (const row of hit) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: hit.length };
    },
    async delete(args: { where: Row }) {
      const row = find(args.where)[0];
      if (!row)
        throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
      rows.splice(rows.indexOf(row), 1);
      return { ...row };
    },
    async deleteMany(args: { where?: Row } = {}) {
      const hit = find(args.where);
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    },
  };
}

function fakePrisma() {
  const db = {
    user: delegate([]),
    session: delegate([]),
    account: delegate([]),
    verificationToken: delegate([]),
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// The signing algorithm of better-call 0.3.x (Better Auth 1.1.x), copied so
// the check keeps proving compatibility after the old package is gone.
// ---------------------------------------------------------------------------

async function legacyHmacKey(secret: string) {
  return webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function legacySign(value: string, secret: string): Promise<string> {
  const sig = await webcrypto.subtle.sign(
    'HMAC',
    await legacyHmacKey(secret),
    new TextEncoder().encode(value),
  );
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`);
}

async function legacyVerify(cookieValue: string, secret: string): Promise<string | null> {
  const value = decodeURIComponent(cookieValue);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const signed = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (sig.length !== 44 || !sig.endsWith('=')) return null;
  const bin = atob(sig);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ok = await webcrypto.subtle.verify(
    'HMAC',
    await legacyHmacKey(secret),
    bytes,
    new TextEncoder().encode(signed),
  );
  return ok ? signed : null;
}

// ---------------------------------------------------------------------------

const SECRET = 'check-session-compat-secret-0123456789abcdef0123456789abcdef';
const API = 'https://api.example.test';
const WEB = 'https://portal.example.test';
const DAY = 24 * 60 * 60 * 1000;

interface SetCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
}

function parseSetCookies(headers: Headers): SetCookie[] {
  return headers.getSetCookie().map((line) => {
    const [pair = '', ...rest] = line.split(';');
    const eq = pair.indexOf('=');
    const attrs = new Map<string, string>();
    for (const part of rest) {
      const [k = '', ...v] = part.trim().split('=');
      attrs.set(k.toLowerCase(), v.join('='));
    }
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attrs };
  });
}

async function setup(cookiePrefix?: string, onSignInFailed?: (email: string) => void) {
  const db = fakePrisma();
  const auth: AppAuth = await createAuth(
    {
      secret: SECRET,
      baseURL: API,
      trustedOrigins: [WEB],
      cookieDomain: '.example.test',
      ...(cookiePrefix ? { cookiePrefix } : {}),
      ...(onSignInFailed ? { onSignInFailed } : {}),
    },
    { prisma: db },
  );
  const now = Date.now();
  db.user.rows.push({
    id: 'cuser000000000000000000001',
    email: 'staff@example.test',
    emailVerified: true,
    name: 'Staff Person',
    image: null,
    createdAt: new Date(now - 300 * DAY),
    updatedAt: new Date(now - 300 * DAY),
  });
  db.account.rows.push({
    id: 'cacct000000000000000000001',
    userId: 'cuser000000000000000000001',
    providerId: 'credential',
    accountId: 'cuser000000000000000000001',
    password: hashPassword('correct horse battery staple'),
    accessToken: null,
    refreshToken: null,
    idToken: null,
    createdAt: new Date(now - 300 * DAY),
    updatedAt: new Date(now - 300 * DAY),
  });
  const addSession = (token: string, expiresAt: Date, updatedAt = new Date(now - 60_000)) =>
    db.session.rows.push({
      id: `csess${token.padStart(21, '0')}`,
      userId: 'cuser000000000000000000001',
      token,
      expiresAt,
      ipAddress: '203.0.113.7',
      userAgent: 'Botss Desktop',
      createdAt: new Date(now - 10 * DAY),
      updatedAt,
    });
  return { db, auth, addSession };
}

async function getSession(auth: AppAuth, cookie: string) {
  const headers = new Headers({ cookie, origin: WEB });
  try {
    return (await auth.api.getSession({ headers })) as {
      session: { token: string; userId: string };
      user: { id: string; email: string };
    } | null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // 1 + 2: cookies minted by Better Auth 1.1.x keep working.
  for (const prefix of [undefined, 'botss-staging']) {
    const label = prefix ?? 'default prefix';
    const name = `${prefix ?? 'better-auth'}.session_token`;
    const { auth, addSession } = await setup(prefix);
    addSession('existingtoken0000000000000000001', new Date(Date.now() + 20 * DAY));
    addSession('expiredtoken00000000000000000001', new Date(Date.now() - DAY));

    const legacy = await legacySign('existingtoken0000000000000000001', SECRET);
    const s = await getSession(auth, `${name}=${legacy}`);
    check(
      `${label}: a 1.1.x session cookie still resolves`,
      s?.user.id === 'cuser000000000000000000001',
    );
    check(
      `${label}: it resolves to its own session`,
      s?.session.token === 'existingtoken0000000000000000001',
    );

    const forged = await legacySign('existingtoken0000000000000000001', `${SECRET}x`);
    check(
      `${label}: forged signature refused`,
      (await getSession(auth, `${name}=${forged}`)) === null,
    );
    const unknown = await legacySign('notarealtoken0000000000000000001', SECRET);
    check(
      `${label}: unknown token refused`,
      (await getSession(auth, `${name}=${unknown}`)) === null,
    );
    const expired = await legacySign('expiredtoken00000000000000000001', SECRET);
    check(
      `${label}: expired session refused`,
      (await getSession(auth, `${name}=${expired}`)) === null,
    );
    const otherName = prefix ? 'better-auth.session_token' : 'botss-staging.session_token';
    check(
      `${label}: the other deployment's cookie name is ignored`,
      (await getSession(auth, `${otherName}=${legacy}`)) === null,
    );
  }

  // 3: sign-in issues the same cookie name and format.
  for (const rememberMe of [true, false]) {
    const { db, auth } = await setup();
    const res: Response = await auth.handler(
      new Request(`${API}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB },
        body: JSON.stringify({
          email: 'staff@example.test',
          password: 'correct horse battery staple',
          rememberMe,
        }),
      }),
    );
    check(
      `sign-in (rememberMe=${rememberMe}) succeeds`,
      res.status === 200,
      `status ${res.status}`,
    );
    const cookie = parseSetCookies(res.headers).find((c) => c.name === 'better-auth.session_token');
    check(`sign-in (rememberMe=${rememberMe}) sets better-auth.session_token`, !!cookie);
    if (!cookie) continue;
    const token = await legacyVerify(cookie.value, SECRET);
    check('new cookie verifies with the 1.1.x algorithm', token !== null);
    check(
      'new cookie carries a stored session token',
      db.session.rows.some((r) => r.token === token),
    );
    check('cookie is HttpOnly', cookie.attrs.has('httponly'));
    check('cookie is Secure', cookie.attrs.has('secure'));
    check('cookie is SameSite=None', cookie.attrs.get('samesite')?.toLowerCase() === 'none');
    check('cookie is scoped to the parent domain', cookie.attrs.get('domain') === '.example.test');
    check('cookie path is /', cookie.attrs.get('path') === '/');
    if (rememberMe) {
      check(
        'remembered cookie lives 30 days',
        cookie.attrs.get('max-age') === String(30 * 24 * 60 * 60),
      );
    } else {
      check('unremembered cookie is a browser-session cookie', !cookie.attrs.has('max-age'));
    }
    const s = await getSession(auth, `better-auth.session_token=${cookie.value}`);
    check('the issued cookie resolves', s?.user.email === 'staff@example.test');
  }

  // 4: sliding expiry and sign-out.
  {
    const { db, auth, addSession } = await setup();
    addSession(
      'slidingtoken00000000000000000001',
      new Date(Date.now() + 5 * DAY),
      new Date(Date.now() - 2 * DAY),
    );
    const legacy = await legacySign('slidingtoken00000000000000000001', SECRET);
    const s = await getSession(auth, `better-auth.session_token=${legacy}`);
    check('a day-old session still resolves', s !== null);
    const row = db.session.rows.find((r) => r.token === 'slidingtoken00000000000000000001');
    const expires = row?.expiresAt instanceof Date ? row.expiresAt.getTime() : 0;
    check(
      'its expiry slides to ~30 days out',
      expires > Date.now() + 29 * DAY,
      new Date(expires).toISOString(),
    );

    const out: Response = await auth.handler(
      new Request(`${API}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: `better-auth.session_token=${legacy}`, origin: WEB },
      }),
    );
    check('sign-out succeeds', out.status === 200, `status ${out.status}`);
    check(
      'sign-out deletes the session row',
      !db.session.rows.some((r) => r.token === 'slidingtoken00000000000000000001'),
    );
  }

  // 5: the sign-in failure hook.
  {
    const calls: string[] = [];
    const { auth } = await setup(undefined, (email) => calls.push(email));
    const signIn = (email: string, password: string): Promise<Response> =>
      auth.handler(
        new Request(`${API}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB },
          body: JSON.stringify({ email, password }),
        }),
      );

    const wrong = await signIn('staff@example.test', 'wrong password entirely');
    check('wrong password is refused with 401', wrong.status === 401, `status ${wrong.status}`);
    check(
      'wrong password calls onSignInFailed once with the email',
      calls.length === 1 && calls[0] === 'staff@example.test',
      JSON.stringify(calls),
    );

    calls.length = 0;
    const unknown = await signIn('nobody@example.test', 'correct horse battery staple');
    check('unknown email is refused with 401', unknown.status === 401, `status ${unknown.status}`);
    check(
      'unknown email calls onSignInFailed once with the email',
      calls.length === 1 && calls[0] === 'nobody@example.test',
      JSON.stringify(calls),
    );

    calls.length = 0;
    const ok = await signIn('staff@example.test', 'correct horse battery staple');
    check('correct password signs in', ok.status === 200, `status ${ok.status}`);
    check(
      'successful sign-in does not call onSignInFailed',
      calls.length === 0,
      JSON.stringify(calls),
    );
  }

  if (failures > 0) {
    console.error(`check-session-compat: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('check-session-compat: OK');
}

main().catch((err) => {
  console.error('check-session-compat crashed', err);
  process.exit(1);
});
