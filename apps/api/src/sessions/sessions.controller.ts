import { Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  cuid,
  type MySessionsResponse,
  mySessionsResponseSchema,
  type SessionsRevokedResponse,
  sessionsRevokedResponseSchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RealtimeEventsService } from '../notifications/realtime-events.service';
import { SessionsService } from './sessions.service';

/**
 * `/api/v1/users/me/sessions` - the caller's own devices.
 *
 * `@SkipPermissions` because there is no CASL subject: every query is pinned
 * to the session user's id (no user id in the path or body), and the global
 * AuthGuard has already required a signed-in STAFF account. Revoking closes
 * only the live sockets whose `sessionId` was deleted, so the device the
 * caller is using stays connected.
 */
@Controller('users/me/sessions')
@SkipPermissions()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Req() req: { sessionId?: string },
  ): Promise<MySessionsResponse> {
    const items = await this.sessions.listMine(user.id, req.sessionId);
    return mySessionsResponseSchema.parse({ items });
  }

  // Static path first so it is never read as a session id.
  @Post('revoke-others')
  @HttpCode(200)
  async revokeOthers(
    @CurrentUser() user: AuthedUser,
    @Req() req: { sessionId?: string },
  ): Promise<SessionsRevokedResponse> {
    const ids = await this.sessions.revokeOthers(user.id, req.sessionId);
    this.realtime.publishSessionIdsRevoked(user.id, ids);
    return sessionsRevokedResponseSchema.parse({ ok: true, revoked: ids.length });
  }

  @Delete(':id')
  async revokeOne(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ): Promise<SessionsRevokedResponse> {
    const ids = await this.sessions.revokeMine(user.id, id);
    this.realtime.publishSessionIdsRevoked(user.id, ids);
    return sessionsRevokedResponseSchema.parse({ ok: true, revoked: ids.length });
  }
}
