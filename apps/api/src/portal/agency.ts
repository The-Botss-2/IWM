import { invoiceSettingsSchema } from '@botss/shared-types';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The company running a client portal, as clients see it: our invoice
 * branding (company name and logo), falling back to the organization name.
 * Used for the portal header, portal emails and the accept page.
 */
export async function agencyBranding(
  prisma: PrismaService,
  organizationId: string,
): Promise<{ name: string; logoUrl: string | null }> {
  const org = await prisma.client.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, invoiceSettings: true },
  });
  const parsed = invoiceSettingsSchema.safeParse(org?.invoiceSettings ?? {});
  const settings = parsed.success ? parsed.data : {};
  let logoUrl: string | null = null;
  if (settings.logoFileId) {
    const logo = await prisma.client.fileObject.findFirst({
      where: { id: settings.logoFileId, workspace: { organizationId } },
      select: { url: true },
    });
    logoUrl = logo?.url ?? null;
  }
  return { name: settings.companyName || org?.name || 'Client portal', logoUrl };
}
