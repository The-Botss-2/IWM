import { requireTenantRef } from '../common/tenant-scope';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * A payment source usable from `workspaceId`: sources are organization-wide,
 * so it must belong to the workspace's organization. Anything else is the
 * standard 400 `invalid_payment_source`, never "exists in another org".
 */
export async function paymentSourceForWorkspace(
  prisma: PrismaService,
  workspaceId: string,
  paymentSourceId: string,
) {
  const ws = await prisma.client.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const source = ws
    ? await prisma.client.paymentSource.findFirst({
        where: { id: paymentSourceId, organizationId: ws.organizationId },
        select: { id: true, defaultRegion: true },
      })
    : null;
  return requireTenantRef(source, 'payment source', 'invalid_payment_source');
}
