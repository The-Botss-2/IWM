import {
  auditLogListResponseSchema,
  platformLogListResponseSchema,
  type AuditLogListResponse,
  type ListAuditLogQuery,
  type PlatformLogListResponse,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export class AuditLogResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListAuditLogQuery>): Promise<AuditLogListResponse> {
    return this.http.get('/audit-log', auditLogListResponseSchema, query);
  }

  /** SUPER_ADMIN only: organization-level events across all organizations. */
  listPlatform(query?: Partial<ListAuditLogQuery>): Promise<PlatformLogListResponse> {
    return this.http.get('/audit-log/platform', platformLogListResponseSchema, query);
  }
}
