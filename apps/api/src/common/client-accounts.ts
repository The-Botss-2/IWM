import { ConflictException } from '@nestjs/common';

/**
 * Client-portal accounts (`User.accountType = CLIENT`) are separate from
 * staff accounts: one email cannot be both, and no staff flow may adopt a
 * portal account into an org or a workspace. Portal accounts carry
 * `organizationId = null`, which slips past cross-org checks written as
 * `existing.organizationId && existing.organizationId !== orgId`, so every
 * path that attaches an EXISTING user by email calls this first.
 */
export function assertNotClientAccount(accountType: string | null | undefined): void {
  if (accountType === 'CLIENT') {
    throw new ConflictException({
      title: 'Client portal account',
      status: 409,
      detail:
        "This email belongs to a client portal account. Manage it from the client's Portal tab.",
      code: 'client-portal-account',
    });
  }
}
