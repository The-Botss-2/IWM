import { ForbiddenException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * A DM or group whose participants are not all in one organization - today
 * only a DM opened from an accepted chat request. Channels never span orgs.
 * Exposed to the web as a boolean only; no organization id leaves the API.
 */
export function spansOrganizations(
  type: string,
  participants: Array<{ user: { organizationId: string | null } }>,
): boolean {
  if (type !== 'DM' && type !== 'GROUP') return false;
  return new Set(participants.map((p) => p.user.organizationId)).size > 1;
}

/**
 * A cross-organization DM goes quiet once either side blocks the other (from
 * a chat request or from the DM header): nothing new may reach the other
 * person - no messages, edits, reactions, forwards, calls or call tokens.
 * Same-org rooms are never affected. Shared by ChatService and LivekitService.
 */
export async function assertNotBlockedInCrossOrgDm(
  prisma: PrismaService,
  userId: string,
  roomId: string,
): Promise<void> {
  const room = await prisma.client.chatRoom.findFirst({
    where: { id: roomId, deletedAt: null, type: 'DM' },
    select: {
      participants: {
        select: { userId: true, user: { select: { organizationId: true } } },
      },
    },
  });
  if (!room || !spansOrganizations('DM', room.participants)) return;
  const peerIds = room.participants.map((p) => p.userId).filter((id) => id !== userId);
  if (peerIds.length === 0) return;
  const block = await prisma.client.chatRequestBlock.findFirst({
    where: {
      OR: [
        { blockerId: userId, blockedUserId: { in: peerIds } },
        { blockerId: { in: peerIds }, blockedUserId: userId },
      ],
    },
    select: { id: true },
  });
  if (block) {
    throw new ForbiddenException({
      title: "You can't message this person",
      status: 403,
    });
  }
}
