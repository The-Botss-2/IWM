import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';
import type { LivekitTokenRequest, LivekitTokenResponse } from '@botss/shared-types';

import { assertNotBlockedInCrossOrgDm } from '../chat/cross-org-block';
import { orgWorkspaceMembership } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LiveKit token minting. Each call goes through the chat-room access check
 * so a user can't request a token for a room they don't belong to. Tokens
 * are scoped to a single LiveKit room and expire after `TOKEN_TTL_SECONDS`.
 *
 * Env required:
 *   - `LIVEKIT_URL`     wss://livekit.example.com
 *   - `LIVEKIT_API_KEY`
 *   - `LIVEKIT_API_SECRET`
 *
 * When any of these is missing every method throws BadRequest so the
 * misconfiguration surfaces at the first call instead of silently emitting
 * unusable tokens.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private static readonly TOKEN_TTL_SECONDS = 6 * 60 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async mintToken(userId: string, input: LivekitTokenRequest): Promise<LivekitTokenResponse> {
    const url = this.config.get<string>('LIVEKIT_URL');
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');
    if (!url || !apiKey || !apiSecret) {
      throw new BadRequestException({
        title: 'LiveKit not configured',
        status: 400,
        detail:
          'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set on the API for video/voice rooms.',
      });
    }

    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: input.roomId, deletedAt: null },
      include: {
        participants: { where: { userId }, select: { id: true } },
      },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }

    // Voice-channel kind only makes sense on workspace-scoped channels.
    // Reject calls that try to mint a voice-channel token against a DM
    // (which has no concept of persistent presence - the call lifecycle
    // is the room).
    if (input.kind === 'voice-channel' && room.type !== 'VOICE_CHANNEL') {
      throw new BadRequestException({
        title: 'Not a voice channel',
        status: 400,
        detail: 'This chat room is not a voice channel.',
      });
    }

    // Membership check. For private rooms (DM/GROUP/private channels) the
    // user must be in participants. For public workspace channels the
    // server falls back to a workspace-membership lookup.
    const isParticipant = room.participants.length > 0;
    if (!isParticipant) {
      if (
        (room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL') &&
        !room.isPrivate &&
        room.workspaceId
      ) {
        // Org-scoped: a leftover membership into another org does not count.
        const ws = await orgWorkspaceMembership(this.prisma, userId, room.workspaceId);
        if (!ws) {
          throw new ForbiddenException({
            title: 'Not a member of this room',
            status: 403,
          });
        }
      } else {
        throw new ForbiddenException({
          title: 'Not a member of this room',
          status: 403,
        });
      }
    }

    // A cross-organization DM where either side blocked the other gets no
    // call token (initiateCall refuses too; this closes the direct route).
    await assertNotBlockedInCrossOrgDm(this.prisma, userId, room.id);

    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      throw new NotFoundException({ title: 'User not found', status: 404 });
    }

    // LiveKit room name. Keeping the chat-room id 1:1 with the LiveKit
    // identifier means we don't need a side table mapping the two, and
    // any server-side state stays naturally aligned.
    const roomName =
      input.kind === 'voice-channel' ? `voice:${input.roomId}` : `call:${input.roomId}`;
    const identity = user.id;

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: user.name || user.email,
      ttl: LivekitService.TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    return {
      url,
      token,
      roomName,
      identity,
    };
  }
}
