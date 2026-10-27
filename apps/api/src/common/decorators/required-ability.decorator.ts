import { SetMetadata } from '@nestjs/common';
import type { AppAction, AppSubject } from '@botss/auth';

export interface RequiredAbility {
  action: AppAction;
  subject: AppSubject;
}

export const REQUIRED_ABILITY_KEY = 'requiredAbility';

/** Declares the CASL ability the PermissionsGuard must check before allowing the request. */
export const RequireAbility = (action: AppAction, subject: AppSubject): MethodDecorator =>
  SetMetadata(REQUIRED_ABILITY_KEY, { action, subject });
