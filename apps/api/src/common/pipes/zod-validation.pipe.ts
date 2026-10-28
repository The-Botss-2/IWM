import { BadRequestException, Logger, type PipeTransform } from '@nestjs/common';
import type { ZodError, ZodTypeAny, z } from 'zod';

import { humanizeField } from '../humanize-field';

export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  private static readonly logger = new Logger('ZodValidationPipe');

  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fieldErrors = zodErrorToFieldErrors(result.error);
      // Surface the failure in the dev console so 400s aren't opaque. The
      // raw payload is intentionally NOT logged because it can contain
      // secrets (passwords, tokens, mail bodies) - only the field paths
      // and the reasons are emitted.
      ZodValidationPipe.logger.warn(`Validation failed: ${JSON.stringify(fieldErrors)}`);
      // Build a short human-readable detail. RFC 7807 keeps the structured
      // map under `errors`, but the toast on the client renders `detail`
      // first; including a one-liner there means the user sees the cause
      // immediately without inspecting devtools. Paths are humanized
      // (`/items/0/unitPrice` -> "Unit price"); `errors` keeps the raw
      // JSON-pointer keys for programmatic use.
      const summary = Object.entries(fieldErrors)
        .slice(0, 3)
        .map(([k, msgs]) => `${humanizeField(k)}: ${msgs.join(', ')}`)
        .join(' • ');
      throw new BadRequestException({
        title: 'Validation Failed',
        status: 400,
        detail: summary || 'One or more fields failed validation.',
        errors: fieldErrors,
        code: 'validation_failed',
      });
    }
    return result.data;
  }
}

function zodErrorToFieldErrors(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? '/' + issue.path.join('/') : '/';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
