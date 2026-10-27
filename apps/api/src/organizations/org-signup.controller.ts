import { Body, Controller, Post } from '@nestjs/common';

import {
  publicOrganizationSignupSchema,
  type PublicOrganizationSignupInput,
  type PublicOrganizationSignupResponse,
} from '@botss/shared-types';

import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';

/**
 * Public, unauthenticated organization self-signup - the "Are you an
 * organization? Sign up now" flow linked from the sign-in page. Kept in
 * its own controller (rather than OrganizationsController) because that
 * one is class-level gated behind GlobalAdminGuard and every route there
 * is global-admin-only tenant management.
 *
 * Abuse surface is bounded by:
 *  - per-IP rate limit on /org-signup in main.ts (5 per hour),
 *  - the response never echoing the invitation URL (email-only delivery),
 *  - the same duplicate-email / reserved-slug rejections as the admin flow.
 */
@Controller('org-signup')
export class OrgSignupController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @Public()
  signup(
    @Body(new ZodValidationPipe(publicOrganizationSignupSchema))
    input: PublicOrganizationSignupInput,
  ): Promise<PublicOrganizationSignupResponse> {
    return this.organizations.signupSelfServe(input);
  }
}
