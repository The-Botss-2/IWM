import { Body, Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { requestPermissions } from '../common/permissions/effective-permissions';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { assertMayRunTestEmail, mailHealthOrgId } from './email-admin-policy';
import { EmailService } from './email.service';

/**
 * Admin-only test endpoint. Sends a real (non-queued) email through the
 * configured SMTP transport so operators can verify deliverability from
 * production without provisioning a real invitation/reset flow.
 *
 * The schema is local to this controller because it's not consumed by the
 * web api-client - every other endpoint's input lives in `@botss/shared-types`.
 */
const sendTestEmailSchema = z.object({
  to: z.string().email(),
  message: z.string().max(500).default('SMTP test from The Botss admin panel.'),
});
type SendTestEmailInput = z.infer<typeof sendTestEmailSchema>;

@Controller('admin/email')
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Post('test')
  @SkipPermissions()
  async test(
    @Req() req: Request & RequestExtensions,
    @Body(new ZodValidationPipe(sendTestEmailSchema)) input: SendTestEmailInput,
  ) {
    // SkipPermissions() because CASL has no admin/email subject; the gate is
    // assertMayRunTestEmail (platform admins only, own address unless
    // SUPER_ADMIN). Authentication is still enforced by the global AuthGuard.
    const user = requireUser(req);
    assertMayRunTestEmail(user, requestPermissions(req), input.to);
    return this.email.sendTestInline(input.to, input.message);
  }

  /**
   * Diagnostic endpoint that describes which mail transport is active
   * and (for the env transport) pings SMTP without actually sending an
   * email. Cheap to run; used by the "Test mail config" affordance in
   * the create-tenant success dialog so the admin can tell at a glance
   * whether their tenant invitation just failed because of a wrong
   * SMTP_PASSWORD vs because Gmail filed it as spam.
   *
   * No cross-org parameter: tenants always get their own organization's
   * transport; SUPER_ADMIN gets the platform's env transport (the one tenant
   * invites fall back to). The live SMTP verify is cached (see
   * EmailService.describeTransport) so this cannot hammer the relay login.
   */
  @Get('health')
  @SkipPermissions()
  async health(@Req() req: Request & RequestExtensions) {
    const user = requireUser(req);
    const memberships = req.workspaceMemberships ?? [];
    const isAdmin =
      user.systemRole === 'SUPER_ADMIN' ||
      memberships.some((m) => m.role === 'OWNER' || m.role === 'ADMIN');
    if (!isAdmin) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Workspace OWNER or ADMIN role required to view mail health.',
      });
    }
    return this.email.describeTransport(mailHealthOrgId(user));
  }
}

function requireUser(req: RequestExtensions): NonNullable<RequestExtensions['user']> {
  if (!req.user) {
    throw new ForbiddenException({ title: 'Forbidden', status: 403, detail: 'Not signed in.' });
  }
  return req.user;
}
