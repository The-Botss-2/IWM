/**
 * BullMQ queue for sealing completed signature requests. Sealing loads the
 * frozen PDF, stamps every signature, appends the certificate page and stores
 * the result, so it runs off the signer's request and retries on failure.
 */
export const SIGNATURES_QUEUE = 'signatures';

export interface SealJobData {
  requestId: string;
}

export const SEAL_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24 * 30, count: 1000 },
} as const;

/** One seal job per request at a time; BullMQ ignores a duplicate id. */
export function sealJobId(requestId: string): string {
  return `seal-${requestId}`;
}
