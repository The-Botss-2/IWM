import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  addMailAccountSchema,
  type AddMailAccountInput,
  createMailSignatureSchema,
  type CreateMailSignatureInput,
  cuid,
  selfSetupMailboxSchema,
  type SelfSetupMailboxInput,
  updateMailAccountSchema,
  type UpdateMailAccountInput,
  updateMailSignatureSchema,
  type UpdateMailSignatureInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { MailAccountsService } from './mail-accounts.service';

@Controller('mail/accounts')
export class MailAccountsController {
  constructor(private readonly accounts: MailAccountsService) {}

  // Every method is gated by AuthGuard globally, but mail accounts have no
  // CASL subject in the ability map (they belong to a single user, not to the
  // workspace ability matrix). Each method enforces user ownership in the
  // service layer.

  @Get()
  @SkipPermissions()
  list(@CurrentUser() user: AuthedUser) {
    return this.accounts.list(user.id);
  }

  @Post()
  @SkipPermissions()
  add(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(addMailAccountSchema)) input: AddMailAccountInput,
  ) {
    return this.accounts.add(workspaceId, user.id, input);
  }

  /**
   * One-click setup for users whose email is on the cPanel-managed domain.
   * Resets the cPanel mailbox password to the user's chosen value and
   * provisions a MailAccount with the same password. Works for the admin
   * themselves and any pre-existing user that was never wired up via the
   * admin create flow.
   */
  @Post('self-setup')
  @SkipPermissions()
  selfSetup(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(selfSetupMailboxSchema)) input: SelfSetupMailboxInput,
  ) {
    return this.accounts.selfSetup(workspaceId, user.id, input.password);
  }

  @Patch(':id')
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateMailAccountSchema)) input: UpdateMailAccountInput,
  ) {
    return this.accounts.update(user.id, id, input);
  }

  @Post(':id/signatures')
  @SkipPermissions()
  addSignature(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(createMailSignatureSchema))
    input: CreateMailSignatureInput,
  ) {
    return this.accounts.addSignature(user.id, id, input);
  }

  @Patch(':id/signatures/:signatureId')
  @SkipPermissions()
  updateSignature(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('signatureId', new ZodValidationPipe(cuid)) signatureId: string,
    @Body(new ZodValidationPipe(updateMailSignatureSchema))
    input: UpdateMailSignatureInput,
  ) {
    return this.accounts.updateSignature(user.id, id, signatureId, input);
  }

  @Delete(':id/signatures/:signatureId')
  @SkipPermissions()
  removeSignature(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('signatureId', new ZodValidationPipe(cuid)) signatureId: string,
  ) {
    return this.accounts.removeSignature(user.id, id, signatureId);
  }

  @Post(':id/test')
  @SkipPermissions()
  test(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.accounts.test(user.id, id);
  }

  @Delete(':id')
  @SkipPermissions()
  async remove(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.accounts.remove(user.id, id);
    return { ok: true };
  }
}
