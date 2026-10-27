import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { hashPassword } from '@botss/auth';
import type {
  AcceptInvitationInput,
  AcceptInvitationResponse,
  InvitationInfo,
  InvitationPreview,
} from '@botss/shared-types';

import {
  accessCodeMatches,
  attemptsExhausted,
  MAX_ACCESS_CODE_ATTEMPTS,
} from '../common/access-code';
import { agencyBranding } from '../portal/agency';
import { livePortalContactWhere } from '../portal/portal-scope';
import {
  parsePortalTokenIdentifier,
  portalTokensForUser,
  type PortalTokenKind,
} from '../portal/portal-tokens';
import { PrismaService } from '../prisma/prisma.service';
import { parseInvitationIdentifier } from './invitation-tokens';

type TokenRow = {
  id: string;
  identifier: string;
  expiresAt: Date;
  codeHash: string | null;
  codeAttempts: number;
};

/**
 * One-time links behind `/invitations/accept`: workspace invites for staff,
 * and the client portal's invite and password-reset links. The identifier
 * prefix on the `VerificationToken` row says which.
 *
 * Workspace invites carry two factors: the 32-byte token in the link and the
 * 6-digit code printed in the same email. Nothing about the invitation (who,
 * which workspace) is revealed, and nothing can be accepted, until the code
 * checks out; MAX_ACCESS_CODE_ATTEMPTS wrong codes delete the token. Portal
 * links were never weakened (32 random bytes) and need no code.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public, unauthenticated: only what the accept page needs to pick its
   * first screen. 410 if expired, 404 if unknown.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const tokenRow = await this.liveToken(token);
    const portal = parsePortalTokenIdentifier(tokenRow.identifier);
    if (portal) return { kind: portal.kind, requiresCode: false };
    if (!parseInvitationIdentifier(tokenRow.identifier) || !tokenRow.codeHash) {
      // Pre-code workspace links are no longer accepted.
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    return { kind: 'workspace', requiresCode: true };
  }

  /**
   * Check the code (workspace invites) and return enough context to greet
   * the invitee and decide whether to render "Set password" or "Sign in".
   */
  async verify(token: string, code: string | undefined): Promise<InvitationInfo> {
    const tokenRow = await this.liveToken(token);

    const portal = parsePortalTokenIdentifier(tokenRow.identifier);
    if (portal) return this.portalInfo(portal);

    const parsed = parseInvitationIdentifier(tokenRow.identifier);
    if (!parsed) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    await this.assertCode(tokenRow, code);
    const { workspaceId, userId } = parsed;

    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: {
        workspace: { select: { name: true } },
        user: {
          select: {
            email: true,
            accounts: {
              where: { providerId: 'credential' },
              select: { id: true },
              take: 1,
            },
          },
        },
        invitedBy: { select: { name: true } },
      },
    });
    if (!membership) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }

    return {
      email: membership.user.email,
      workspaceName: membership.workspace.name,
      inviterName: membership.invitedBy?.name ?? null,
      hasPassword: membership.user.accounts.length > 0,
      kind: 'workspace',
      clientName: null,
    };
  }

  /**
   * Accept the invitation: set the user's FIRST password, mark email
   * verified, delete the token, end any existing sessions. The frontend
   * follows up with a Better Auth sign-in call to create a session - this
   * endpoint stays decoupled from the Better Auth runtime so it remains
   * testable. Password rules live in `acceptInvitationSchema`.
   *
   * Like a portal invite, a workspace invite never replaces an existing
   * password: someone holding a forwarded or intercepted invite (link and
   * code) must not be able to take over an account that is already set up.
   */
  async accept(
    token: string,
    input: AcceptInvitationInput,
  ): Promise<AcceptInvitationResponse> {
    const tokenRow = await this.liveToken(token);

    const portal = parsePortalTokenIdentifier(tokenRow.identifier);
    if (portal) return this.acceptPortal(tokenRow, portal, input);

    const parsed = parseInvitationIdentifier(tokenRow.identifier);
    if (!parsed) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    await this.assertCode(tokenRow, input.code);
    const { workspaceId, userId } = parsed;

    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            accounts: { where: { providerId: 'credential' }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    if (!membership) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    if (membership.user.accounts.length > 0) {
      await this.prisma.client.verificationToken
        .delete({ where: { id: tokenRow.id } })
        .catch(() => undefined);
      throw alreadySetUp();
    }

    const passwordHash = hashPassword(input.password);

    await this.prisma.client.$transaction(async (tx) => {
      // Checked again inside the transaction: two invite links for one person
      // (two workspaces) accepted at once must not let the second overwrite
      // the password the first just set.
      const existing = await tx.account.findFirst({
        where: { userId, providerId: 'credential' },
        select: { id: true },
      });
      if (existing) throw alreadySetUp();
      await tx.account.create({
        data: {
          userId,
          providerId: 'credential',
          accountId: userId,
          password: passwordHash,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { emailVerified: true } });
      await tx.verificationToken.delete({ where: { id: tokenRow.id } });
      // A password now exists: nothing signed in before it should survive.
      await tx.session.deleteMany({ where: { userId } });
    });

    this.logger.log(`[INVITE_ACCEPT] workspace=${workspaceId} user=${userId}`);

    return { ok: true, workspaceId, userId, destination: 'app' };
  }

  /**
   * Second factor for workspace invites. A token without a code hash (links
   * minted before codes existed) is refused. Wrong codes count; the last
   * allowed wrong code deletes the token, so the inviter must resend.
   */
  private async assertCode(tokenRow: TokenRow, code: string | undefined): Promise<void> {
    if (!tokenRow.codeHash) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    if (attemptsExhausted(tokenRow.codeAttempts)) {
      await this.prisma.client.verificationToken
        .delete({ where: { id: tokenRow.id } })
        .catch(() => undefined);
      throw invitationLocked();
    }
    if (!code) {
      throw new HttpException(
        {
          title: 'Code required',
          status: 401,
          detail: 'Enter the 6-digit code from your invitation email.',
          code: 'invitation-code-required',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (accessCodeMatches(code, tokenRow.codeHash)) {
      if (tokenRow.codeAttempts > 0) {
        await this.prisma.client.verificationToken.updateMany({
          where: { id: tokenRow.id },
          data: { codeAttempts: 0 },
        });
      }
      return;
    }
    const bumped = await this.prisma.client.verificationToken.update({
      where: { id: tokenRow.id },
      data: { codeAttempts: { increment: 1 } },
      select: { codeAttempts: true },
    });
    if (attemptsExhausted(bumped.codeAttempts)) {
      await this.prisma.client.verificationToken
        .delete({ where: { id: tokenRow.id } })
        .catch(() => undefined);
      this.logger.warn(`[INVITE_LOCKED] identifier=${tokenRow.identifier}`);
      throw invitationLocked();
    }
    const left = MAX_ACCESS_CODE_ATTEMPTS - bumped.codeAttempts;
    throw new HttpException(
      {
        title: 'Wrong code',
        status: 401,
        detail: `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
        code: 'invitation-code-invalid',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }

  // --------------------------------------------------------------------------
  // Client portal links
  // --------------------------------------------------------------------------

  private async portalInfo(p: {
    kind: PortalTokenKind;
    clientId: string;
    userId: string;
  }): Promise<InvitationInfo> {
    const contact = await this.livePortalContact(p.clientId, p.userId);
    const agency = await agencyBranding(this.prisma, contact.client.workspace.organizationId);
    return {
      email: contact.user.email,
      workspaceName: agency.name,
      inviterName: contact.invitedBy?.name ?? null,
      hasPassword: contact.user.accounts.length > 0,
      kind: p.kind,
      clientName: contact.client.name,
    };
  }

  /**
   * An invite link sets the FIRST password only and is refused once one
   * exists, so a forwarded or intercepted invite can never take over an
   * account. A reset link replaces the password and signs the person out
   * everywhere. Both re-check that the contact is still live: revoking
   * access, or deleting the client, kills an unused link.
   */
  private async acceptPortal(
    tokenRow: TokenRow,
    p: { kind: PortalTokenKind; clientId: string; userId: string },
    input: AcceptInvitationInput,
  ): Promise<AcceptInvitationResponse> {
    const contact = await this.livePortalContact(p.clientId, p.userId);
    const hasPassword = contact.user.accounts.length > 0;
    if (p.kind === 'portal-invite' && hasPassword) {
      await this.prisma.client.verificationToken
        .delete({ where: { id: tokenRow.id } })
        .catch(() => undefined);
      throw new ConflictException({
        title: 'Already set up',
        status: 409,
        detail: 'This account already has a password. Sign in instead.',
        code: 'already-set-up',
      });
    }

    const passwordHash = hashPassword(input.password);
    await this.prisma.client.$transaction(async (tx) => {
      const credential = await tx.account.findFirst({
        where: { userId: p.userId, providerId: 'credential' },
        select: { id: true },
      });
      // Checked again inside the transaction: two live invite links for one
      // person (two clients) accepted at the same moment must not let the
      // second overwrite the password the first just set.
      if (p.kind === 'portal-invite' && credential) {
        throw new ConflictException({
          title: 'Already set up',
          status: 409,
          detail: 'This account already has a password. Sign in instead.',
          code: 'already-set-up',
        });
      }
      if (credential) {
        await tx.account.update({
          where: { id: credential.id },
          data: { password: passwordHash },
        });
      } else {
        await tx.account.create({
          data: {
            userId: p.userId,
            providerId: 'credential',
            accountId: p.userId,
            password: passwordHash,
          },
        });
      }
      await tx.user.update({ where: { id: p.userId }, data: { emailVerified: true } });
      await tx.verificationToken.delete({ where: { id: tokenRow.id } });
      // The password is account-wide: every other outstanding link of this
      // kind for the person (other clients) is moot now.
      await tx.verificationToken.deleteMany({ where: portalTokensForUser(p.kind, p.userId) });
      if (p.kind === 'portal-reset') {
        await tx.session.deleteMany({ where: { userId: p.userId } });
      }
    });

    this.logger.log(`[PORTAL_${p.kind === 'portal-reset' ? 'RESET' : 'INVITE'}_ACCEPT] client=${p.clientId} user=${p.userId}`);
    return {
      ok: true,
      workspaceId: contact.client.workspaceId,
      userId: p.userId,
      destination: 'portal',
    };
  }

  private async livePortalContact(clientId: string, userId: string) {
    const contact = await this.prisma.client.clientContact.findFirst({
      where: { ...livePortalContactWhere(userId), clientId },
      select: {
        client: {
          select: {
            name: true,
            workspaceId: true,
            workspace: { select: { organizationId: true } },
          },
        },
        invitedBy: { select: { name: true } },
        user: {
          select: {
            email: true,
            accounts: { where: { providerId: 'credential' }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    if (!contact) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    return contact;
  }

  /** Exact match on the 32-byte link token; the route already refused any
   *  other shape (`invitationToken`), so a 6-digit value never gets here. */
  private async liveToken(token: string): Promise<TokenRow> {
    const tokenRow = await this.prisma.client.verificationToken.findFirst({
      where: { value: token },
      select: { id: true, identifier: true, expiresAt: true, codeHash: true, codeAttempts: true },
    });
    if (!tokenRow) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    if (tokenRow.expiresAt.getTime() < Date.now()) {
      throw new GoneException({ title: 'Invitation expired', status: 410 });
    }
    return tokenRow;
  }
}

function alreadySetUp(): ConflictException {
  return new ConflictException({
    title: 'Already set up',
    status: 409,
    detail: 'This account already has a password. Sign in instead.',
    code: 'already-set-up',
  });
}

function invitationLocked(): HttpException {
  return new HttpException(
    {
      title: 'Invitation locked',
      status: 423,
      detail: 'Too many wrong codes were entered. Ask whoever invited you to send it again.',
      code: 'invitation-code-locked',
    },
    423, // Locked (HttpStatus has no LOCKED member in Nest 10)
  );
}
