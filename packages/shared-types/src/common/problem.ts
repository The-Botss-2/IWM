import { z } from 'zod';

/** RFC 7807 Problem Details for HTTP APIs. */
export const problemDetailsSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Field-level validation errors (extension). Keyed by JSON pointer to the offending field. */
  errors: z.record(z.array(z.string())).optional(),
  /** Application-specific machine code (extension). */
  code: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
