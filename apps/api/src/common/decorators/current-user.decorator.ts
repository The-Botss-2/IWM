import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccountType, SystemRole } from '@botss/shared-types';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  /** Populated by AuthGuard on every authenticated request. */
  systemRole: SystemRole;
  /** Populated by AuthGuard; null for legacy users with no tenant and for
   *  every CLIENT (portal) account. */
  organizationId: string | null;
  /** STAFF, or CLIENT for a client-portal person (portal routes only). */
  accountType: AccountType;
}

/** Resolves the authenticated user attached to the request by AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthedUser }>();
    return req.user;
  },
);
