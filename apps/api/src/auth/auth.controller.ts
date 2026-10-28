import { Controller, Get, Req } from '@nestjs/common';
import { sessionContextSchema } from '@botss/shared-types';
import { rawPrisma } from '@botss/database';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';

@Controller('auth')
export class AuthController {
  /**
   * Returns the current session context: user + workspace memberships + project
   * memberships (for the CASL ability factory on the frontend).
   *
   * Open to CLIENT (portal) accounts too, so the web app can tell which kind
   * of account signed in: for those, AuthGuard has already set an empty
   * context (no workspace, no memberships) and `user.accountType` is CLIENT.
   *
   * Better Auth's own routes (sign-in, sign-up, sign-out, etc.) are mounted in
   * `main.ts` directly under `/api/auth/*` outside the global API prefix.
   */
  @PortalRoute('both')
  @Get('me')
  async me(@CurrentUser() user: AuthedUser, @Req() req: Request & RequestExtensions) {
    const fullUser = await rawPrisma.user.findUnique({ where: { id: user.id } });
    return sessionContextSchema.parse({
      // In a support session the app must see what the request runs as: a
      // read only viewer of the granted organization, not the platform role.
      user:
        req.support && fullUser
          ? {
              ...fullUser,
              systemRole: user.systemRole,
              organizationId: user.organizationId,
              customRoleId: null,
            }
          : fullUser,
      currentWorkspaceId: req.workspaceId,
      workspaceMemberships: req.workspaceMemberships,
      projectMemberships: req.projectMemberships,
      permissions: req.permissions ?? { company: [], workspace: [] },
      ...(req.support ? { support: req.support } : {}),
    });
  }
}
