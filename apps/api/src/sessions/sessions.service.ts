import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { MySession } from '@botss/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import { parseUserAgent } from './user-agent';

/**
 * The caller's own signed-in devices. Every query is pinned to `userId`, so a
 * session id belonging to someone else is indistinguishable from one that does
 * not exist (404). Rows past `expiresAt` are not listed.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(userId: string, currentSessionId: string | undefined): Promise<MySession[]> {
    const rows = await this.prisma.client.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, updatedAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      ...parseUserAgent(r.userAgent),
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      lastActiveAt: r.updatedAt.toISOString(),
      current: r.id === currentSessionId,
    }));
  }

  /**
   * Delete one of the caller's own sessions and return its id (so the caller
   * can close that device's live socket). 404 when it is not theirs.
   */
  async revokeMine(userId: string, sessionId: string): Promise<string[]> {
    const ids = await this.deleteWhere({ id: sessionId, userId });
    if (ids.length === 0) {
      throw new NotFoundException({ title: 'Session not found', status: 404 });
    }
    return ids;
  }

  /**
   * Delete every session of the caller except the one making the request and
   * return the deleted ids. Without a known current session this refuses
   * rather than signing the caller out everywhere.
   */
  async revokeOthers(userId: string, currentSessionId: string | undefined): Promise<string[]> {
    if (!currentSessionId) {
      throw new UnauthorizedException({
        title: 'Session not found',
        status: 401,
        detail: 'Sign in again, then retry.',
      });
    }
    return this.deleteWhere({ userId, id: { not: currentSessionId } });
  }

  /** Select then delete the same ids in one transaction. */
  private async deleteWhere(where: {
    userId: string;
    id: string | { not: string };
  }): Promise<string[]> {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.session.findMany({ where, select: { id: true } });
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        await tx.session.deleteMany({ where: { id: { in: ids }, userId: where.userId } });
      }
      return ids;
    });
  }

  /** Delete all of a user's sessions (admin action, org check done by caller). */
  async revokeAllFor(userId: string): Promise<number> {
    const { count } = await this.prisma.client.session.deleteMany({ where: { userId } });
    return count;
  }
}
