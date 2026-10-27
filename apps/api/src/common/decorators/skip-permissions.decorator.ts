import { SetMetadata } from '@nestjs/common';

export const SKIP_PERMISSIONS_KEY = 'skipPermissions';
/** Skips the PermissionsGuard for this route. AuthGuard still runs unless @Public is also set. */
export const SkipPermissions = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_PERMISSIONS_KEY, true);
