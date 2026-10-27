import { Controller, Get, Query } from '@nestjs/common';
import {
  listAuditLogQuerySchema,
  type ListAuditLogQuery,
} from '@botss/shared-types';

import {
  CurrentUser,
  type AuthedUser,
} from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuditLogService } from './audit-log.service';

/**
 * Read-only audit endpoints. `GET /audit-log` is the caller's own
 * organization's log (anyone with `audit.view`, SUPER_ADMIN included, sees
 * only their own org). `GET /audit-log/platform` is the SUPER_ADMIN platform
 * log: organization-level events only; the service enforces the role.
 */
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema))
    query: ListAuditLogQuery,
  ) {
    return this.auditLog.list(user.id, query);
  }

  @Get('platform')
  @SkipPermissions()
  listPlatform(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema))
    query: ListAuditLogQuery,
  ) {
    return this.auditLog.listPlatform(user.id, query);
  }
}
