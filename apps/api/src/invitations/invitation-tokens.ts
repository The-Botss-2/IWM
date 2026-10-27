import { newAccessCode, newLinkToken } from '../common/access-code';
import type { PrismaService } from '../prisma/prisma.service';

export const INVITATION_TTL_DAYS = 7;
const INVITATION_PREFIX = 'workspace-invite';

export function invitationIdentifier(workspaceId: string, userId: string): string {
  return `${INVITATION_PREFIX}:${workspaceId}:${userId}`;
}

export function parseInvitationIdentifier(
  identifier: string,
): { workspaceId: string; userId: string } | null {
  const prefix = `${INVITATION_PREFIX}:`;
  if (!identifier.startsWith(prefix)) return null;
  const rest = identifier.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const workspaceId = rest.slice(0, sep);
  const userId = rest.slice(sep + 1);
  if (!workspaceId || !userId) return null;
  return { workspaceId, userId };
}

/**
 * Mint a workspace invitation: a 32-byte link token (the URL) plus a 6-digit
 * code (second factor, emailed next to the link). Any outstanding token for
 * the same (workspace, user) pair is deleted first, so older links and codes
 * stop working. Shared by workspace invites and the org-owner bootstrap, which
 * use the same `workspace-invite:` identifier.
 *
 * The code is stored only as a hash. Never log the URL or the code.
 */
export async function issueWorkspaceInvitation(
  prisma: PrismaService,
  appUrl: string,
  args: { workspaceId: string; userId: string },
): Promise<{ url: string; code: string }> {
  const identifier = invitationIdentifier(args.workspaceId, args.userId);
  const token = newLinkToken();
  const code = newAccessCode();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.client.$transaction([
    prisma.client.verificationToken.deleteMany({ where: { identifier } }),
    prisma.client.verificationToken.create({
      data: { identifier, value: token.raw, codeHash: code.hash, expiresAt },
    }),
  ]);

  return {
    url: `${appUrl.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(token.raw)}`,
    code: code.raw,
  };
}
