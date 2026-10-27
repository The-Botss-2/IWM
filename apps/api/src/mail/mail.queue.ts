export const MAIL_QUEUE = 'mail';

/**
 * Outbound user mail gets its own queue and worker. It used to share `mail`
 * with verify-account and initial-sync on a single worker with concurrency 1,
 * so one slow IMAP sync held every user's outgoing message in line behind it.
 */
export const MAIL_SEND_QUEUE = 'mail-send';
export const MAIL_SEND_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.MAIL_SEND_CONCURRENCY ?? '5', 10) || 5,
);

export type MailJobData =
  | { kind: 'verify-account'; accountId: string }
  | { kind: 'initial-sync'; accountId: string; folderPath?: string }
  | { kind: 'send'; outboxId: string }
  | { kind: 'resync-folder'; accountId: string; folderId: string };

export const MAIL_VERIFY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 500 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 2000 },
} as const;

/**
 * Manual full re-sync of one folder runs on its own queue, one at a time, so
 * a long folder refetch never holds verify-account/initial-sync in line.
 */
export const MAIL_RESYNC_QUEUE = 'mail-resync';

/**
 * Manual full re-sync of one folder (folder context menu). One job per
 * folder at a time: the id is per folder and is freed when the job ends, so
 * clicks while one is pending join it instead of queueing another.
 */
export const mailResyncJobId = (folderId: string): string => `resync-folder-${folderId}`;
export const MAIL_RESYNC_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export const MAIL_SEND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 2000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
} as const;
