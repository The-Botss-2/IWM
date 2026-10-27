/**
 * Who may view a signature request, as a where-fragment: the requester, a
 * workspace owner/admin, or anyone who can read the (live) source document.
 * The list form of `SignaturesService.loadForView`, which uses it too, so a
 * request that opens for someone is exactly a request listed for them.
 *
 * Pure (no Prisma calls) so `scripts/check-client-hub.ts` can check it.
 */
export function signatureVisibleWhere(actor: {
  userId: string;
  workspaceId: string;
  workspaceRole: string | null | undefined;
}): Record<string, unknown> {
  if (actor.workspaceRole === 'OWNER' || actor.workspaceRole === 'ADMIN') {
    return { workspaceId: actor.workspaceId };
  }
  return {
    workspaceId: actor.workspaceId,
    OR: [
      { createdById: actor.userId },
      {
        document: {
          // Nested: the soft-delete extension only filters the top level.
          deletedAt: null,
          workspaceId: actor.workspaceId,
          OR: [{ createdById: actor.userId }, { access: { some: { userId: actor.userId } } }],
        },
      },
    ],
  };
}
