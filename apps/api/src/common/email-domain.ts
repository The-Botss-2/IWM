import { ForbiddenException } from '@nestjs/common';

/**
 * Tenant rules for which email addresses an organization may put on a user.
 *
 * The cPanel domain (CPANEL_DOMAIN) is the platform's own mail server: a
 * tenant that could create `someone@<cpanel domain>` would provision a real
 * mailbox on our server, or pass as platform staff. A domain another
 * organization has claimed (`Organization.emailDomain`) belongs to that
 * tenant; auto-routing would otherwise drop the user into the wrong org or
 * let one tenant impersonate another's staff.
 *
 * The platform (root) organization is exempt: it owns the cPanel domain and
 * provisions accounts for any tenant.
 */

export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

export function cpanelDomain(): string | null {
  const d = (process.env.CPANEL_DOMAIN ?? '').trim().toLowerCase();
  return d || null;
}

export interface EmailDomainCheck {
  /** The organization the user will belong to; null while it is being created. */
  orgId: string | null;
  /** True when the acting organization is the platform (root) org. */
  actorOrgIsRoot: boolean;
  email: string;
  /** Id of the active organization that claims this domain, if any. */
  claimingOrgId: (domain: string) => Promise<string | null>;
  /** Override for tests; defaults to CPANEL_DOMAIN. */
  cpanelDomain?: string | null;
}

export async function assertEmailDomainAllowed(check: EmailDomainCheck): Promise<void> {
  if (check.actorOrgIsRoot) return;
  const domain = emailDomainOf(check.email);
  if (!domain) return;
  const reserved = check.cpanelDomain === undefined ? cpanelDomain() : check.cpanelDomain;
  if (reserved && domain === reserved.toLowerCase()) {
    throw domainNotAllowed(domain);
  }
  const claimedBy = await check.claimingOrgId(domain);
  if (claimedBy && claimedBy !== check.orgId) {
    throw domainNotAllowed(domain);
  }
}

function domainNotAllowed(domain: string): ForbiddenException {
  return new ForbiddenException({
    title: 'Email domain not allowed',
    status: 403,
    detail: `Addresses on ${domain} belong to another organization.`,
    code: 'email-domain-not-allowed',
  });
}
