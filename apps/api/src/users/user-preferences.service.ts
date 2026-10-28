import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@botss/database';
import {
  parseStoredUserPreferences,
  type UserPreferences,
  USER_PREFERENCES_VERSION,
  type UserPreferencesResponse,
} from '@botss/shared-types';

import { PrismaService } from '../prisma/prisma.service';

/** Optimistic-concurrency retries before a PATCH gives up with a 409. Two
 *  devices saving in the same instant is the only way to need more than one. */
const MAX_WRITE_ATTEMPTS = 4;

/**
 * Merge a partial update into a stored document. Sections merge key-by-key so
 * a PATCH of `{ appearance: { theme } }` keeps the stored gradient, layout and
 * hidden list; arrays (`navigation.hidden`) are replaced, never concatenated.
 * Pure: neither argument is mutated.
 */
export function mergeUserPreferences(
  base: UserPreferences,
  patch: UserPreferences,
): UserPreferences {
  const out: UserPreferences = {};
  const appearance = { ...base.appearance, ...patch.appearance };
  if (Object.keys(appearance).length > 0) out.appearance = appearance;
  const navigation = { ...base.navigation, ...patch.navigation };
  if (navigation.hidden) navigation.hidden = [...navigation.hidden];
  if (Object.keys(navigation).length > 0) out.navigation = navigation;
  return out;
}

function toResponse(row: { data: unknown; updatedAt: Date } | null): UserPreferencesResponse {
  return {
    version: USER_PREFERENCES_VERSION,
    preferences: parseStoredUserPreferences(row?.data),
    updatedAt: row?.updatedAt ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * The signed-in user's own appearance + navigation preferences. Always keyed
 * by the session user id - there is deliberately no way to address another
 * user's row.
 */
@Injectable()
export class UserPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<UserPreferencesResponse> {
    const row = await this.prisma.client.userPreferences.findUnique({
      where: { userId },
      select: { data: true, updatedAt: true },
    });
    return toResponse(row);
  }

  /**
   * Read-merge-write with optimistic concurrency on `updatedAt`, so two
   * devices patching different keys at the same moment both land instead of
   * the later write silently dropping the earlier one's key.
   */
  async update(userId: string, patch: UserPreferences): Promise<UserPreferencesResponse> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const row = await this.prisma.client.userPreferences.findUnique({
        where: { userId },
        select: { data: true, updatedAt: true },
      });
      const merged = mergeUserPreferences(parseStoredUserPreferences(row?.data), patch);
      const data = {
        version: USER_PREFERENCES_VERSION,
        ...merged,
      } as Prisma.InputJsonObject;

      if (!row) {
        try {
          const created = await this.prisma.client.userPreferences.create({
            data: { userId, data },
            select: { data: true, updatedAt: true },
          });
          return toResponse(created);
        } catch (err) {
          // Another device created the row first; merge onto theirs.
          if (isUniqueViolation(err)) continue;
          throw err;
        }
      }

      // Strictly later than the version we read, even if the clock has not
      // ticked a millisecond since that write.
      const now = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
      const res = await this.prisma.client.userPreferences.updateMany({
        where: { userId, updatedAt: row.updatedAt },
        data: { data, updatedAt: now },
      });
      if (res.count === 1) return toResponse({ data, updatedAt: now });
    }
    throw new ConflictException({
      title: 'Preferences changed concurrently',
      status: 409,
      detail: 'Your preferences were being saved from another device. Try again.',
      code: 'preferences_conflict',
    });
  }
}
