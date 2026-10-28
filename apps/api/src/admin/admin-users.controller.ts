import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  adminCreateUserSchema,
  type AdminCreateUserInput,
  adminImportWebmailUserSchema,
  type AdminImportWebmailUserInput,
  adminUpdateUserSchema,
  type AdminUpdateUserInput,
  cuid,
  type SessionsRevokedResponse,
  sessionsRevokedResponseSchema,
} from '@botss/shared-types';
import { z } from 'zod';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AdminUsersService } from './admin-users.service';

/**
 * Admin user-management surface. Every endpoint here calls
 * `AdminUsersService.assertAdmin` first; non-admins receive a 403 without
 * any data leaking. `@SkipPermissions()` is intentional - CASL abilities
 * are scoped by workspace, but this surface is system-wide.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly admin: AdminUsersService) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query('search', new ZodValidationPipe(z.string().max(255).optional())) search?: string,
  ) {
    // Always the actor's own organization. A stale client that still sends
    // `organizationId` is not rejected; the param is simply not read.
    return this.admin.list(user.id, search);
  }

  @Post()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(adminCreateUserSchema)) input: AdminCreateUserInput,
  ) {
    return this.admin.create(user.id, workspaceId, input);
  }

  @Get('webmail-candidates')
  @SkipPermissions()
  listWebmailCandidates(@CurrentUser() user: AuthedUser) {
    return this.admin.listWebmailCandidates(user.id);
  }

  @Post('import')
  @SkipPermissions()
  importWebmailUser(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(adminImportWebmailUserSchema))
    input: AdminImportWebmailUserInput,
  ) {
    return this.admin.importWebmailUser(user.id, workspaceId, input);
  }

  @Patch(':id')
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(adminUpdateUserSchema)) input: AdminUpdateUserInput,
  ) {
    return this.admin.update(user.id, id, input);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @SkipPermissions()
  async revokeSessions(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ): Promise<SessionsRevokedResponse> {
    const revoked = await this.admin.revokeUserSessions(user.id, id);
    return sessionsRevokedResponseSchema.parse({ ok: true, revoked });
  }

  @Delete(':id')
  @SkipPermissions()
  async remove(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.admin.remove(user.id, id);
    return { ok: true };
  }
}
