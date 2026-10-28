import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type { Request, Response } from 'express';

import { MailHostRefusedError } from '../../mail/mail-ssrf';
import { humanizeField } from '../humanize-field';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, string[]>;
  code?: string;
}

/** The request path without its query string or fragment. */
export function pathWithoutQuery(url: string | undefined): string {
  return (url ?? '').split(/[?#]/)[0] ?? '';
}

@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Path only: the query string can carry a support token (`?st=`), which
    // must never be echoed back or written to the logs.
    const path = pathWithoutQuery(req.originalUrl ?? req.url);
    const body = scrubProblemBody(this.toProblemBody(exception, path));

    res.status(body.status).type('application/problem+json').json(body);

    if (body.status >= 500) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(`${body.status} ${req.method} ${path}\n${stack}`);
    }
  }

  private toProblemBody(exception: unknown, instance: string): ProblemBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      let title = exception.message;
      let detail: string | undefined;
      let errors: Record<string, string[]> | undefined;
      let code: string | undefined;
      if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        if (typeof r.title === 'string') title = r.title;
        if (typeof r.detail === 'string') detail = r.detail;
        if (r.errors && typeof r.errors === 'object') {
          errors = r.errors as Record<string, string[]>;
        }
        if (typeof r.code === 'string') code = r.code;
      }
      return { type: 'about:blank', title, status, detail, instance, errors, code };
    }

    // A refused mail host is bad input (the user typed it), not a server
    // fault: every HTTP path that reaches mail-ssrf answers 400.
    if (exception instanceof MailHostRefusedError) {
      return {
        type: 'about:blank',
        title: 'Mail server not allowed',
        status: HttpStatus.BAD_REQUEST,
        detail: exception.message,
        instance,
        code: 'mail-host-refused',
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const m = mapPrismaError(exception);
      return { type: 'about:blank', ...m, instance, code: exception.code };
    }

    // Other Prisma failures (bad query shape, engine panic, lost connection)
    // carry engine text that is meaningless to users - even outside
    // production, keep it in the server log only.
    if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientRustPanicError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      return {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'The server had a problem. Try again in a moment.',
        instance,
      };
    }

    const detail =
      process.env.NODE_ENV === 'production'
        ? 'The server had a problem. Try again in a moment.'
        : exception instanceof Error
          ? exception.message
          : String(exception);

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail,
      instance,
    };
  }
}

/**
 * Prisma errors in plain language. Raw Prisma text ("Unique constraint failed
 * on …", "Foreign key constraint failed", "Prisma error P2034") never reaches
 * the client; `scripts/check-problem-details.ts` guards that.
 */
function mapPrismaError(e: Prisma.PrismaClientKnownRequestError): {
  status: number;
  title: string;
  detail: string;
} {
  switch (e.code) {
    case 'P2002': {
      const what = describeTarget(e.meta);
      return {
        status: HttpStatus.CONFLICT,
        title: 'Already exists',
        detail: what
          ? `Something with this ${what} already exists.`
          : 'Something with these details already exists.',
      };
    }
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        title: 'Not Found',
        detail: 'That record was not found. It may have been deleted or moved.',
      };
    case 'P2003':
      return {
        status: HttpStatus.BAD_REQUEST,
        title: 'Linked item missing',
        detail: 'Something this refers to no longer exists. Refresh and try again.',
      };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        title: 'Something went wrong',
        detail: "We couldn't save or load this data. Try again in a moment.",
      };
  }
}

/**
 * The unique fields from `meta.target` as words ("email", "name and slug"),
 * or null. Foreign-key columns (`*Id`) only scope the uniqueness and mean
 * nothing to a user, so they are dropped. A constraint name
 * (`Client_organizationId_email_key`) is split into its column names.
 */
function describeTarget(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || !('target' in meta)) return null;
  const t = (meta as { target?: unknown }).target;
  let fields: string[] = [];
  if (Array.isArray(t)) {
    fields = t.filter((f): f is string => typeof f === 'string');
  } else if (typeof t === 'string') {
    const parts = t.split(/[,\s]+/).filter(Boolean);
    fields =
      parts.length === 1 && /_(key|pkey|idx|unique)$/i.test(t)
        ? t
            .replace(/_(key|pkey|idx|unique)$/i, '')
            .split('_')
            .slice(1)
        : parts;
  }
  const words = fields
    .filter((f) => f && f !== 'id' && !/Id$/.test(f) && !/_id$/i.test(f))
    .map((f) => humanizeField(f).toLowerCase());
  return words.length ? words.join(' and ') : null;
}

/**
 * Strip likely secrets from outgoing problem-detail bodies. Mirrors the
 * client-side `scrubSecrets` so both ends sanitize independently - even
 * a bug-fix gap on one side doesn't let a key reach the user.
 *
 * Common leak sources we've seen:
 *   - LiveKit SDK errors with the API key embedded in the message
 *   - AWS SDK errors that echo Access Key IDs in their detail
 *   - SMTP / IMAP errors with passwords in the diagnostic string
 *   - Upstream HTTP errors carrying the raw bearer / signed URL
 */
function scrubProblemBody(body: ProblemBody): ProblemBody {
  return {
    ...body,
    title: scrubSecrets(body.title),
    ...(body.detail !== undefined ? { detail: scrubSecrets(body.detail) } : {}),
    ...(body.errors
      ? {
          errors: Object.fromEntries(
            Object.entries(body.errors).map(([field, msgs]) => [field, msgs.map(scrubSecrets)]),
          ),
        }
      : {}),
  };
}

function scrubSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<token>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer <token>');
  out = out.replace(/\bAPI[A-Za-z0-9]{14,}\b/g, '<key>');
  out = out.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16,}\b/g, '<key>');
  out = out.replace(/(https?:\/\/)[^:@/\s]+:[^@\s]+@/gi, '$1<redacted>@');
  out = out.replace(
    /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|api[_-]?secret|token)\s*[:=]\s*([^\s,;]+)/gi,
    '$1=<redacted>',
  );
  out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, (match) => {
    if (/^[0-9a-f]+$/i.test(match)) return match;
    if (!/[A-Za-z]/.test(match) || !/[0-9]/.test(match)) return match;
    return '<key>';
  });
  return out;
}
