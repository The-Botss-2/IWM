import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

import { requestAuthFor } from './request-context';

/**
 * Tenant-scope helpers: the one way to accept an id that the caller supplies
 * for another record (a receipt file, a sprint, a parent goal...). The lookup
 * itself is always a query filtered by the caller's workspace or
 * organization; these helpers turn a miss into the same RFC 7807 problem
 * everywhere and never say whether the id exists in another tenant.
 */

/** 400 problem for an id that is not in the caller's workspace/organization. */
export function invalidReference(what: string, code: string): BadRequestException {
  return new BadRequestException({
    title: `Invalid ${what}`,
    status: 400,
    detail: `That ${what} was not found in this workspace.`,
    code,
  });
}

/** `row` from a tenant-scoped query, or the standard invalid-reference 400. */
export function requireTenantRef<T>(row: T | null | undefined, what: string, code: string): T {
  if (row === null || row === undefined) throw invalidReference(what, code);
  return row;
}

/** A user's organization, from this request's auth snapshot when it is theirs. */
export async function userOrgId(prisma: PrismaService, userId: string): Promise<string | null> {
  const cached = requestAuthFor(userId);
  if (cached) return cached.organizationId;
  const u = await prisma.client.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { organizationId: true },
  });
  return u?.organizationId ?? null;
}

/**
 * The user's membership of `workspaceId`, only when that workspace is in the
 * user's own organization. A leftover membership into another org (a user
 * moved between orgs) counts as none, matching what AuthGuard resolves.
 * AuthGuard also drops deleted workspaces; this helper intentionally does
 * not, because restore flows still need the role.
 */
export async function orgWorkspaceMembership(
  prisma: PrismaService,
  userId: string,
  workspaceId: string,
) {
  const orgId = await userOrgId(prisma, userId);
  if (!orgId) return null;
  return prisma.client.workspaceMembership.findFirst({
    where: { workspaceId, userId, workspace: { organizationId: orgId } },
    select: { id: true, role: true },
  });
}
