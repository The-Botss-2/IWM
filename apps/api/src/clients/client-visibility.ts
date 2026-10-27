import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@botss/database';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';

/**
 * Who may see which client, in one place.
 *
 * READ: full sales access sees every client in the workspace; so do the org
 * finance roles (ADMIN / SUPER_ADMIN / FINANCE), because billing is per
 * client and a finance manager is rarely the assignee. Everyone else sees
 * only clients assigned to them.
 *
 * WRITE (update, reassign, delete, portal changes): unchanged. Finance
 * visibility is read-only, so a FINANCE user who is also a plain workspace
 * MEMBER (and therefore holds `update Client`) still cannot edit a client
 * that is not assigned to them.
 *
 * Kept free of Prisma calls so
 * `scripts/check-client-hub.ts` can check the rules without a database.
 */

type ClientViewer = Pick<SalesActor, 'userId' | 'workspaceId' | 'fullClients' | 'financeAccess'>;

/** Clients this actor may READ. Always pinned to the active workspace. */
export function clientVisibleWhere(actor: ClientViewer): Prisma.ClientWhereInput {
  return actor.fullClients || actor.financeAccess
    ? { workspaceId: actor.workspaceId }
    : { workspaceId: actor.workspaceId, assigneeId: actor.userId };
}

/** Clients this actor may CHANGE. Finance visibility never applies here. */
export function clientWritableWhere(actor: ClientViewer): Prisma.ClientWhereInput {
  return actor.fullClients
    ? { workspaceId: actor.workspaceId }
    : { workspaceId: actor.workspaceId, assigneeId: actor.userId };
}

export function clientNotFound(): NotFoundException {
  return new NotFoundException({ title: 'Client not found', status: 404 });
}

/**
 * The client, or a 404 when this actor may not read it. A client that exists
 * but is hidden 404s rather than 403s so the response never confirms it.
 *
 * The caller runs the query (`find` receives the where-clause) so it keeps
 * Prisma's inferred row type for its own `select`.
 */
export async function requireVisibleClient<T>(
  actor: ClientViewer,
  clientId: string,
  find: (where: Prisma.ClientWhereInput) => Promise<T | null>,
): Promise<T> {
  const row = await find({ AND: [{ id: clientId }, clientVisibleWhere(actor)] });
  if (!row) throw clientNotFound();
  return row;
}

/** Same, for routes that change the client (or something hanging off it). */
export async function requireWritableClient<T>(
  actor: ClientViewer,
  clientId: string,
  find: (where: Prisma.ClientWhereInput) => Promise<T | null>,
): Promise<T> {
  const row = await find({ AND: [{ id: clientId }, clientWritableWhere(actor)] });
  if (!row) throw clientNotFound();
  return row;
}
