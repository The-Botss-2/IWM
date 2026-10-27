import { z } from 'zod';

/**
 * Opaque entity identifier. Most rows use Prisma's `@default(cuid())` so the
 * value is a canonical cuid, but Better Auth assigns User / Session / Account
 * IDs in its own 32-char format that does NOT match the strict cuid regex.
 *
 * We relax the validator to "any reasonable identifier" so both formats pass.
 * The underlying DB query still rejects unknown IDs, and the length cap blocks
 * pathological inputs on route parameters.
 */
export const cuid = z.string().min(1).max(64);
export const cuidParam = z.object({ id: cuid });
export type CuidParam = z.infer<typeof cuidParam>;
