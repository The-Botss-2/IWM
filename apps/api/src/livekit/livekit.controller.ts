import { Body, Controller, Post } from '@nestjs/common';
import { livekitTokenRequestSchema, type LivekitTokenRequest } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { LivekitService } from './livekit.service';

/**
 * Mounts `POST /livekit/token`. Auth is global; permissions are skipped
 * because the room-membership check inside the service is the
 * authoritative gate (CASL doesn't model LiveKit rooms).
 */
@Controller('livekit')
export class LivekitController {
  constructor(private readonly livekit: LivekitService) {}

  @Post('token')
  @SkipPermissions()
  token(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(livekitTokenRequestSchema)) input: LivekitTokenRequest,
  ) {
    return this.livekit.mintToken(user.id, input);
  }
}
