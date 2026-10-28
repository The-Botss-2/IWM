import 'reflect-metadata';

// The process role (ROLE=all|api|worker) is pinned from the real process
// environment (your process manager) BEFORE any .env file loads below, so a shared .env can
// never flip the worker into an API or back. An invalid value stops the boot
// here with a clear message. See common/process-role.ts.
import { describeProcessRole, getProcessRole } from './common/process-role';

try {
  getProcessRole();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
}

// Load env from the monorepo root (apps/api/dist → ../../../.env). Falling back to
// apps/api/.env or the runtime environment if that path doesn't exist. Done before
// any other imports that read process.env (Better Auth secret, etc.).
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Hierarchical env loader: locate repository root (marked by pnpm-workspace.yaml or turbo.json),
// load the root .env for monorepo-wide settings (SMTP, Redis, S3, etc.), then layer any
// app-level .env / .env.local on top so local overrides are preserved.
const candidateDirs = [
  resolve(process.cwd(), '../..'),
  resolve(process.cwd(), '..'),
  process.cwd(),
  resolve(__dirname, '../../../'),
  resolve(__dirname, '../../'),
  resolve(__dirname, '../'),
  __dirname,
];

let rootDir: string | null = null;
for (const dir of candidateDirs) {
  if (existsSync(resolve(dir, 'pnpm-workspace.yaml')) || existsSync(resolve(dir, 'turbo.json'))) {
    rootDir = dir;
    break;
  }
}

if (rootDir) {
  const rootEnv = resolve(rootDir, '.env');
  const rootEnvLocal = resolve(rootDir, '.env.local');
  if (existsSync(rootEnv)) loadDotenv({ path: rootEnv });
  if (existsSync(rootEnvLocal)) loadDotenv({ path: rootEnvLocal, override: true });
}

const appDir = process.cwd();
if (appDir !== rootDir) {
  const appEnv = resolve(appDir, '.env');
  const appEnvLocal = resolve(appDir, '.env.local');
  if (existsSync(appEnv)) loadDotenv({ path: appEnv, override: true });
  if (existsSync(appEnvLocal)) loadDotenv({ path: appEnvLocal, override: true });
}

import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAuth } from '@botss/auth';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { setAuthInstance } from './auth/auth.service';
import { reportSignInFailure } from './security-alerts/sign-in-failure-sink';
import { isAllowedBetterAuthRoute } from './auth/better-auth-routes';
import { getSharedMailSender } from './email/email.module';
import { bootstrapWorker } from './worker-bootstrap';

// `better-auth/node` is ESM-only; NestJS runs as CommonJS. TypeScript compiles
// `import()` to `require()` under CommonJS, which would re-throw on ESM. The
// `Function('return import(p)')` form preserves a true native dynamic ESM import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, no-new-func
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

const loadToNodeHandler = async (): Promise<
  (auth: unknown) => (req: unknown, res: unknown) => unknown
> => {
  const mod = await dynamicImport('better-auth/node');
  return mod.toNodeHandler;
};

/**
 * Resolve which Nest log levels are enabled.
 *
 * Levels are ordered most-verbose → least-verbose; we enable everything at or
 * above the threshold. The threshold is `LOG_LEVEL` when set (e.g. `debug` to
 * bring back the chatty `logger.debug(...)` diagnostics - session-context
 * resolution, socket connect/disconnect, IMAP sync no-ops - for a debugging
 * session), otherwise it defaults to `debug` in development and `log` in
 * production. That keeps deployed (staging/prod) logs free of debug noise
 * while leaving local dev verbose, and makes re-enabling a one-env-var change
 * rather than a code edit + redeploy.
 */
function resolveLogLevels(): LogLevel[] {
  const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
  const fallback: LogLevel = process.env.NODE_ENV === 'production' ? 'log' : 'debug';
  const requested = process.env.LOG_LEVEL?.trim().toLowerCase();
  const threshold =
    order.indexOf(requested as LogLevel) === -1 ? fallback : (requested as LogLevel);
  return order.slice(order.indexOf(threshold));
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const role = getProcessRole();
  logger.log('Starting API bootstrap...');
  logger.log(`Process role: ${describeProcessRole(role)}`);

  if (!process.env.BETTER_AUTH_SECRET) {
    logger.error('BETTER_AUTH_SECRET is missing from process.env');
    throw new Error('BETTER_AUTH_SECRET is required.');
  }
  logger.log('BETTER_AUTH_SECRET found.');

  // 1) Build Better Auth FIRST and mount its handler in the Express middleware
  //    chain BEFORE NestJS adds its catch-all router (otherwise Nest's 404
  //    swallows the auth routes).
  const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:4000';
  // `WEB_ORIGIN` may be a single value or a comma-separated list so a deployment
  // can simultaneously accept the production frontend and a staging/preview URL.
  const webOriginList = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;
  // Staging sets its own prefix so its cookie never collides with production's.
  const cookiePrefix = process.env.AUTH_COOKIE_PREFIX?.trim() || undefined;

  // Resolve the email transport up front so Nest-side EmailService
  // (workspace invitations) can verify SMTP at boot. Stub-mode (no SMTP_HOST)
  // just logs the payload.
  const mailSender = getSharedMailSender();

  // SMTP verification used to run TWICE on every boot: once here (fire-and-
  // forget diagnostic) and again in `EmailModule.onApplicationBootstrap`.
  // Each verify is a live SMTP AUTH attempt. With wrong credentials this
  // doubled the cPHulk failed-login count per restart - exactly the failure
  // mode that produced today's IP ban (29 restarts × 2 EAUTH = ~60 strikes,
  // far over cPHulk's default 4-in-5-minutes threshold). The module-level
  // check is sufficient and has smarter MailAccount-fallback logic, so we
  // do nothing here and let the module verdict be authoritative.
  if (mailSender.isStub()) {
    logger.log(
      'Env SMTP unset. Transactional transport will be resolved from MailAccount fallbacks at module bootstrap.',
    );
  }

  // The standalone BullMQ producer that used to back the reset-password
  // callback is gone - self-serve reset is disabled platform-wide. The
  // EmailProcessor still handles workspace-invitation jobs via the normal
  // Nest DI flow.

  const auth = await createAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: webOriginList,
    cookieDomain,
    cookiePrefix,
    onSignInFailed: reportSignInFailure,
    // sendResetPassword intentionally omitted. Self-serve password reset is
    // disabled platform-wide; admins rotate user passwords from the Users
    // panel which keeps CRM/cPanel/MailAccount creds in lock-step. The
    // /reset-password and /forgot-password web routes show informational
    // notices instead of forms.
  });
  setAuthInstance(auth);

  // ROLE=worker stops here: same Better Auth instance (services reached from
  // jobs may use it) but no Express app, routes or Socket.IO.
  if (role === 'worker') {
    await bootstrapWorker(resolveLogLevels());
    return;
  }

  const expressApp = express();
  // The API sits behind exactly one reverse proxy (Caddy). Without this,
  // `req.ip` is 127.0.0.1 for every request, so every IP-keyed rate limiter
  // below collapsed into ONE bucket shared by the whole company: ten failed
  // sign-ins anywhere locked everyone out. `TRUST_PROXY_HOPS` overrides the
  // hop count if the proxy chain ever changes; never set it to `true`, which
  // would let clients spoof X-Forwarded-For.
  expressApp.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10));

  // CORS must run BEFORE the Better Auth route handler. better-auth (and the
  // underlying better-call router) does NOT set Access-Control-Allow-* headers
  // - its `trustedOrigins` is only an origin-validation check. If we relied on
  // NestJS's `app.enableCors(...)`, the middleware would attach to the chain
  // AFTER the `expressApp.all('/api/auth/*', ...)` route, never running for
  // auth requests, and the browser would block sign-up/sign-in/sign-out with
  // "Failed to fetch" before any response reached the app.
  const allowedOrigins = new Set(webOriginList);
  // In development, ensure both localhost and 127.0.0.1 are allowed to prevent
  // subtle "Failed to fetch" errors if the browser/OS switches between them.
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }

  const corsMiddleware: express.RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        // Content-Disposition isn't CORS-safelisted, so a cross-origin fetch
        // can't read it unless it's exposed. Binary endpoints (mail attachment
        // download) carry the server-side filename there. Set on the actual
        // response, not just the preflight - that's where it's read.
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Vary', 'Origin');
      } else if (process.env.NODE_ENV !== 'production') {
        // Log rejected origins in dev to help debug "Failed to fetch"
        const logger = new Logger('CORS');
        logger.warn(
          `Rejected origin: ${origin}. Allowed: ${Array.from(allowedOrigins).join(', ')}`,
        );
      }
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
      // Return a fixed allow-list rather than reflecting the requested
      // headers verbatim - reflection lets a caller have any header name
      // echoed back into the response.
      res.setHeader(
        'Access-Control-Allow-Headers',
        // X-Access-Code: the 6-digit second factor of signing links.
        // X-Support-Token: a platform operator's read only support session.
        'Content-Type,Authorization,X-Workspace-Id,Cookie,X-Access-Code,X-Support-Token',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
  expressApp.use(corsMiddleware);

  expressApp.use(
    helmet({
      // The API serves JSON, SSE and file downloads, never a page. A locked
      // CSP means that if any response is ever rendered as a document (a
      // sender-controlled mail part, a misconfigured download), it cannot run
      // script, load anything, or be framed. Routes that intentionally return
      // HTML (invoice preview) set their own header.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          sandbox: [],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  expressApp.use(compression());
  expressApp.use(cookieParser());

  // Rate-limit credential endpoints before Better Auth sees them. The auth
  // handler itself has no built-in throttling, which lets password-spray and
  // user-enumeration attacks run at full request-rate. Defaults: 10 attempts
  // per 15 min per IP. The limiter is in-memory; each API process keeps its
  // own bucket, which is fine for a single server. To scale out
  // horizontally, swap for `rate-limit-redis`.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many auth attempts. Try again later.', status: 429 },
    // Pre-flight CORS requests should not count toward the bucket.
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use('/api/auth/sign-in', authLimiter);
  expressApp.use('/api/auth/sign-up', authLimiter);
  expressApp.use('/api/auth/request-password-reset', authLimiter);
  expressApp.use('/api/auth/forget-password', authLimiter);

  // Throttle the admin "send test email" endpoint. The route already requires
  // workspace OWNER/ADMIN, but without a rate-limit any admin can use it as a
  // free SMTP relay against arbitrary recipients (deliverability poisoning,
  // phishing). 10 sends per 5 min per IP is enough for legitimate diagnostics.
  const apiPrefix = process.env.API_BASE_PATH?.replace(/^\//, '') ?? 'api/v1';
  const emailTestLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many test emails. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/admin/email/test`, emailTestLimiter);

  // Throttle the public, unauthenticated invitation routes (token lookup +
  // accept). The token is a 256-bit random value so brute force is infeasible,
  // but these routes are otherwise unbounded; cap request volume per IP.
  const invitationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many invitation requests. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/invitations`, invitationLimiter);

  // Throttle public organization self-signup hard: every accepted request
  // provisions DB rows (org + user + workspace) and sends an email, so this
  // is the most abusable unauthenticated endpoint we expose. Legitimate use
  // is one submission (maybe two after a typo) per visitor.
  const orgSignupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many signup attempts. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/org-signup`, orgSignupLimiter);

  // Throttle the public chatbot lead intake. It's HMAC-signed, but cap volume
  // per IP so a leaked secret (or junk traffic) can't flood the leads table.
  const leadIntakeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many requests. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/leads/external`, leadIntakeLimiter);

  // Public, unauthenticated content: task-form lookup and submit (each submit
  // writes a task) and public document links (slug probing). The form service
  // keeps its own per-IP Redis cap on submissions; this is the outer bound.
  const publicContentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many requests. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/forms/public`, publicContentLimiter);
  expressApp.use(`/${apiPrefix}/public/documents`, publicContentLimiter);
  // Signing links: session lookups, PDF fetches, sign and decline.
  expressApp.use(`/${apiPrefix}/public/signatures`, publicContentLimiter);

  // Client portal: authenticated, but used by people outside the company, so
  // it gets an outer bound of its own. Looser than the public routes because
  // one portal page load makes several calls and a client's office may share
  // one IP; sign and decline keep the signing service's per-person cap too.
  const portalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many requests. Try again later.', status: 429 },
    skip: (req) => req.method === 'OPTIONS',
  });
  expressApp.use(`/${apiPrefix}/portal`, portalLimiter);

  // Cross-organization chat requests reach people outside the sender's
  // company. The service keeps per-user and per-org Redis caps on sending;
  // this is the outer per-IP bound on every write (send, accept, decline).
  const chatRequestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { title: 'Too many chat requests. Try again later.', status: 429 },
    skip: (req) => req.method !== 'POST',
  });
  expressApp.use(`/${apiPrefix}/chat/requests`, chatRequestLimiter);

  // Only the Better Auth endpoints the apps actually call are reachable; see
  // `auth/better-auth-routes.ts` for why the rest (update-user above all) are
  // closed. Preflights never get here - the CORS middleware ends them.
  expressApp.all('/api/auth/*', (req, res, next) => {
    if (isAllowedBetterAuthRoute(req.method, req.path)) return next();
    res
      .status(404)
      .type('application/problem+json')
      .send(JSON.stringify({ title: 'Not found', status: 404 }));
  });
  const toNodeHandler = await loadToNodeHandler();
  expressApp.all('/api/auth/*', toNodeHandler(auth) as never);

  // 2) Hand the prepared Express app to NestJS via the platform-express adapter.
  //    NestJS's own `app.enableCors(...)` is intentionally NOT called - CORS is
  //    handled uniformly at the Express layer above.
  const logLevels = resolveLogLevels();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(expressApp),
    // rawBody: expose req.rawBody so the public lead intake can verify its HMAC
    // signature over the exact request bytes.
    { bufferLogs: false, logger: logLevels, rawBody: true },
  );

  app.setGlobalPrefix(process.env.API_BASE_PATH?.replace(/^\//, '') ?? 'api/v1');
  // JSON bodies up to 1 MB instead of the 100 KB default: a drawn signature
  // from a high-density phone screen can exceed 100 KB as a base64 data URL
  // (the signing schema caps it at 420,000 characters). Registered before
  // init, so Nest skips its default JSON parser; the rawBody option still
  // applies, which the lead intake's HMAC check relies on.
  app.useBodyParser('json', { limit: '1mb' });

  // Socket.IO adapter for the chat gateway (Phase 3). Must be registered
  // before listen() so gateway lifecycle hooks bind to the underlying HTTP
  // server. The global /api/v1 prefix above does NOT apply to socket.io
  // namespaces - clients connect to ws://host:4000/chat.
  app.useWebSocketAdapter(new IoAdapter(app));

  const port = parseInt(process.env.API_PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://0.0.0.0:${port} (reachable at http://127.0.0.1:${port})`);
  logger.log(
    `Log levels enabled: ${logLevels.join(', ')} (set LOG_LEVEL=debug to enable debug/verbose)`,
  );
  logger.log(
    `Better Auth at /api/auth/*  |  REST routes at /${process.env.API_BASE_PATH?.replace(/^\//, '') ?? 'api/v1'}/*`,
  );
  logger.log(`CORS allowed origins: ${webOriginList.join(', ')} (credentials: true)`);
  if (cookieDomain) {
    logger.log(`Session cookies scoped to domain: ${cookieDomain}`);
  }

  if (typeof process.send === 'function') {
    process.send('ready');
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
