'use client';

import { AuditLogView } from '@/components/admin/audit-log-view';
import { PageLoader } from '@/components/ui/loader';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';
import { getApi } from '@/lib/api';

/**
 * SUPER_ADMIN platform log: organization-level events from every
 * organization, never anything that happens inside one. The server enforces
 * the role; the redirect only spares others a 403.
 */
export default function PlatformLogPage() {
  const gate = useRequireSystemRole(['SUPER_ADMIN']);
  if (gate.checking || !gate.allowed) return <PageLoader label="Loading platform log" />;
  return (
    <AuditLogView
      title="Platform log"
      description="Organizations created, edited, suspended, restored and deleted, owners invited, and security alerts. Nothing else from inside an organization."
      queryKey="platform-log"
      fetchPage={(query) => getApi().auditLog.listPlatform(query)}
      organizationName={(row) => row.organizationName}
      actionPlaceholder="e.g. org.archive"
      alertsFilter
    />
  );
}
