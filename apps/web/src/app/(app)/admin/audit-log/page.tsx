'use client';

import { AuditLogView } from '@/components/admin/audit-log-view';
import { getApi } from '@/lib/api';

/**
 * The organization's own audit log. Everyone with `audit.view`, SUPER_ADMIN
 * included, sees only their own organization; organization-level platform
 * events live on /admin/platform-log.
 */
export default function AdminAuditLogPage() {
  return (
    <AuditLogView
      title="Audit log"
      description="Every sensitive change inside your organization - who, what, when."
      queryKey="audit-log"
      fetchPage={(query) => getApi().auditLog.list(query)}
      actionPlaceholder="e.g. user.role_change"
    />
  );
}
