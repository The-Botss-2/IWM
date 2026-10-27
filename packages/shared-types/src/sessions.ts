import { z } from 'zod';

import { cuid } from './common/id.js';

/**
 * One signed-in device of the caller (a Better Auth `Session` row). The raw
 * `token` is never exposed. `device` / `browser` / `os` are parsed from the
 * stored user agent server-side.
 */
export const mySessionSchema = z.object({
  id: cuid,
  device: z.string(),
  browser: z.string(),
  os: z.string(),
  ipAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** `Session.updatedAt`: when the session was last refreshed. */
  lastActiveAt: z.string().datetime(),
  /** True for the session that made this request. */
  current: z.boolean(),
});
export type MySession = z.infer<typeof mySessionSchema>;

export const mySessionsResponseSchema = z.object({
  items: z.array(mySessionSchema),
});
export type MySessionsResponse = z.infer<typeof mySessionsResponseSchema>;

/** Result of a revoke call; `revoked` is how many sessions were deleted. */
export const sessionsRevokedResponseSchema = z.object({
  ok: z.literal(true),
  revoked: z.number().int().min(0),
});
export type SessionsRevokedResponse = z.infer<typeof sessionsRevokedResponseSchema>;
