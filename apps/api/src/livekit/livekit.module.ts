import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { LivekitController } from './livekit.controller';
import { LivekitService } from './livekit.service';

/**
 * Self-hosted LiveKit integration. The API only mints tokens - the actual
 * WebRTC media never touches the API process. Clients connect directly to
 * the LiveKit server at `LIVEKIT_URL` (WebSocket + UDP/TCP for media).
 */
@Module({
  imports: [PrismaModule],
  controllers: [LivekitController],
  providers: [LivekitService],
  exports: [LivekitService],
})
export class LivekitModule {}
