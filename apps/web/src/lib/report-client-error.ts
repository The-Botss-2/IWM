/**
 * Single sink for errors caught by the Next.js error boundaries. Kept free of
 * imports so `global-error.tsx` (which renders outside the providers) can use
 * it. An error tracker (e.g. Sentry's `captureException`) can connect here;
 * until then it logs the error and its digest to the console so
 * support can match a user's "Reference" to a log line.
 */
export function reportClientError(
  error: unknown,
  ctx: { boundary: 'app' | 'portal' | 'global'; digest?: string },
): void {
  // eslint-disable-next-line no-console
  console.error(`[${ctx.boundary}] route error`, { digest: ctx.digest }, error);
}
