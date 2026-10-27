import { Module } from '@nestjs/common';

import { UserPreferencesController } from './user-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // UserPreferencesController first: its static `users/me/preferences` path
  // must never be shadowed by a parameterised users route.
  controllers: [UserPreferencesController, UsersController],
  providers: [UsersService, UserPreferencesService],
})
export class UsersModule {}
