import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  userPreferencesSchema,
  type UserPreferences,
  userPreferencesResponseSchema,
  type UserPreferencesResponse,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { UserPreferencesService } from './user-preferences.service';

/**
 * `/api/v1/users/me/preferences` - the caller's own appearance + navigation
 * settings, so they follow the person to every device.
 *
 * `@SkipPermissions` because there is no CASL subject to check: the only row
 * reachable is the session user's own (no id in the path or body), and
 * AuthGuard - which stays global - has already required a signed-in STAFF
 * account. Same footing as `PATCH /users/me`.
 */
@Controller('users/me/preferences')
@SkipPermissions()
export class UserPreferencesController {
  constructor(private readonly preferences: UserPreferencesService) {}

  @Get()
  async get(@CurrentUser() user: AuthedUser): Promise<UserPreferencesResponse> {
    return userPreferencesResponseSchema.parse(await this.preferences.get(user.id));
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(userPreferencesSchema)) input: UserPreferences,
  ): Promise<UserPreferencesResponse> {
    return userPreferencesResponseSchema.parse(await this.preferences.update(user.id, input));
  }
}
