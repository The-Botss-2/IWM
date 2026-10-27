import { ForbiddenException } from '@nestjs/common';
import type { EffectivePermissions } from '@botss/auth';

import { ROOT_ORG_ID } from '../organizations/organizations.constants';

interface MailAdminActor {
  email: string;
  systemRole: string;
  organizationId: string | null;
}

/**
 * Who may send a test email through the PLATFORM SMTP transport: the
 * platform operator (SUPER_ADMIN) or a root-org user with `users.manage`.
 * A tenant workspace OWNER/ADMIN may not: anyone can create a tenant through
 * org signup, and the platform sender would then relay their mail.
 *
 * Recipients: SUPER_ADMIN may test any address; everyone else only their own,
 * so the endpoint cannot be used as a relay against third parties.
 */
export function assertMayRunTestEmail(
  actor: MailAdminActor,
  eff: EffectivePermissions,
  to: string,
): void {
  const superAdmin = actor.systemRole === 'SUPER_ADMIN';
  const rootUserManager =
    actor.organizationId === ROOT_ORG_ID && eff.company.includes('users.manage');
  if (!superAdmin && !rootUserManager) {
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'Only platform administrators can send test email.',
    });
  }
  if (!superAdmin && to.trim().toLowerCase() !== actor.email.trim().toLowerCase()) {
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'Test email can only be sent to your own address.',
    });
  }
}

/**
 * Mail health is readable by workspace OWNER/ADMINs, and only ever for their
 * own organization's transport. An organization's mail configuration is its
 * own admins' business; nobody can probe another's. SUPER_ADMIN gets the
 * platform's own env transport (`undefined`) - the one tenant invites fall
 * back to - which holds no tenant data.
 */
export function mailHealthOrgId(actor: MailAdminActor): string | undefined {
  if (actor.systemRole === 'SUPER_ADMIN') return undefined;
  return actor.organizationId ?? undefined;
}
