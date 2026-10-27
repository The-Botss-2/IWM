/**
 * BullMQ queue shapes for transactional email. Producers (EmailService) enqueue
 * a job; the EmailProcessor renders the body and pushes it through MailSender.
 *
 * Keeping the queue's job-data shape *small and serializable* matters: BullMQ
 * persists every payload in Redis. We pass the structured arguments the
 * renderer needs, NOT the pre-rendered HTML/text, so a job replayed after a
 * template change picks up the new content.
 */

export const EMAIL_QUEUE = 'email';

/**
 * Optional org-routing hint. If the producer knows which tenant org the
 * email belongs to (e.g. a password reset for a specific user), include
 * its id here so the processor can fall back to that org's
 * `OrganizationMailConfig` before reaching the platform-default env
 * transport.
 */
interface OrgRoutingHint {
  organizationId?: string;
}

export type EmailJobData =
  | (OrgRoutingHint & {
      kind: 'password-reset';
      to: string;
      recipientName: string | null;
      url: string;
    })
  | (OrgRoutingHint & {
      kind: 'workspace-invitation';
      to: string;
      recipientName: string | null;
      workspaceName: string;
      inviterName: string | null;
      /** Link with the raw token, and the 6-digit second factor. Never log
       *  either. `code` is optional only for jobs queued before it existed. */
      url: string;
      code?: string;
    })
  | (OrgRoutingHint & {
      kind: 'test';
      to: string;
      message: string;
    })
  | (OrgRoutingHint & {
      /** An invoice emailed from the platform address with its PDF attached. */
      kind: 'invoice';
      to: string;
      subject: string;
      message: string | null;
      replyTo: string | null;
      companyName: string;
      invoiceId: string;
      invoiceNumber: string;
      totalLabel: string;
      dueDateLabel: string | null;
      workspaceId: string;
      pdfFileId: string;
    })
  | (OrgRoutingHint & {
      /** A signer's login-free signing link. `url` carries the raw token and
       *  `code` the second factor; never log either. `code` is optional only
       *  so jobs queued before it existed still render. */
      kind: 'signature-request';
      to: string;
      signerName: string | null;
      requesterName: string;
      workspaceName: string;
      title: string;
      message: string | null;
      url: string;
      code?: string;
      expiresAtLabel: string;
      replyTo: string | null;
    })
  | (OrgRoutingHint & {
      /** Everyone signed: the sealed PDF goes to the requester and signers. */
      kind: 'signature-completed';
      to: string;
      title: string;
      workspaceName: string;
      signedSha256: string;
      workspaceId: string;
      pdfFileId: string;
      filename: string;
    })
  | (OrgRoutingHint & {
      /** A signer declined: tells the requester why. */
      kind: 'signature-declined';
      to: string;
      title: string;
      signerEmail: string;
      reason: string;
      url: string;
    })
  | (OrgRoutingHint & {
      /**
       * Client portal. `invite`: first password for a new client person;
       * `access`: someone who already has a password was given another
       * client; `reset`: a staff-sent new-password link. `url` carries a raw
       * one-time token for invite and reset; never log it.
       */
      kind: 'client-portal';
      variant: 'invite' | 'access' | 'reset';
      to: string;
      recipientName: string | null;
      agencyName: string;
      clientName: string;
      inviterName: string | null;
      url: string;
      expiresAtLabel: string | null;
    });

export const EMAIL_JOB_OPTIONS = {
  attempts: 3,
  // Exponential backoff: 1s, 8s, 27s (the cube schedule keeps the first retry
  // fast for a flapping network, then spaces the next two out so we don't
  // hammer a real outage).
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // 24h / 1k jobs
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 }, // 7d / 5k
} as const;
