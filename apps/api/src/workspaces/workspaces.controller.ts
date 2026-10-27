import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createWorkspaceSchema,
  type CreateWorkspaceInput,
  cuid,
  inviteMemberSchema,
  type InviteMemberInput,
  listWorkspacesQuerySchema,
  type ListWorkspacesQuery,
  updateMembershipSchema,
  type UpdateMembershipInput,
  updateWorkspaceSchema,
  type UpdateWorkspaceInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listWorkspacesQuerySchema)) query: ListWorkspacesQuery,
  ) {
    return this.workspaces.listForUser(user.id, query);
  }

  @Post()
  @RequireAbility('create', 'Workspace')
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createWorkspaceSchema)) input: CreateWorkspaceInput,
  ) {
    return this.workspaces.create(user.id, input);
  }

  @Get('current')
  current(@CurrentWorkspaceId() id: string) {
    return this.workspaces.getById(id);
  }

  @Patch('current')
  @RequireAbility('update', 'Workspace')
  updateCurrent(
    @RequestUserScope() scope: UserScope,
    @CurrentWorkspaceId() id: string,
    @Body(new ZodValidationPipe(updateWorkspaceSchema)) input: UpdateWorkspaceInput,
  ) {
    return this.workspaces.update(scope, id, input);
  }

  @Get('current/members')
  currentMembers(@CurrentWorkspaceId() id: string) {
    return this.workspaces.listMembers(id);
  }

  @Post('current/members')
  @RequireAbility('create', 'WorkspaceMembership')
  inviteMember(
    @CurrentWorkspaceId() id: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(inviteMemberSchema)) input: InviteMemberInput,
  ) {
    return this.workspaces.inviteMember(id, user.id, input);
  }

  @Patch('current/members/:membershipId')
  @RequireAbility('update', 'WorkspaceMembership')
  updateMember(
    @CurrentWorkspaceId() id: string,
    @CurrentUser() user: AuthedUser,
    @Param('membershipId', new ZodValidationPipe(cuid)) membershipId: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) input: UpdateMembershipInput,
  ) {
    return this.workspaces.updateMemberRole(id, user.id, membershipId, input);
  }

  @Delete('current/members/:membershipId')
  @RequireAbility('delete', 'WorkspaceMembership')
  async removeMember(
    @CurrentWorkspaceId() id: string,
    @CurrentUser() user: AuthedUser,
    @Param('membershipId', new ZodValidationPipe(cuid)) membershipId: string,
  ) {
    await this.workspaces.removeMember(id, user.id, membershipId);
    return { ok: true };
  }

  /**
   * Resend (regenerate) the invitation token for a pending membership. Old
   * token is invalidated. Returns the new invitation URL - the admin can
   * copy-paste it until SMTP is wired up.
   */
  @Post('current/members/:membershipId/resend-invite')
  @RequireAbility('create', 'WorkspaceMembership')
  resendInvitation(
    @CurrentWorkspaceId() id: string,
    @CurrentUser() user: AuthedUser,
    @Param('membershipId', new ZodValidationPipe(cuid)) membershipId: string,
  ) {
    return this.workspaces.resendInvitation(id, user.id, membershipId);
  }

  /**
   * Revoke a pending invitation: removes the membership row and clears the
   * outstanding token. For *accepted* members use DELETE /members/:id instead.
   */
  @Delete('current/members/:membershipId/invite')
  @RequireAbility('delete', 'WorkspaceMembership')
  async revokeInvitation(
    @CurrentWorkspaceId() id: string,
    @CurrentUser() user: AuthedUser,
    @Param('membershipId', new ZodValidationPipe(cuid)) membershipId: string,
  ) {
    await this.workspaces.revokeInvitation(id, user.id, membershipId);
    return { ok: true };
  }

  /** Members of the workspace owning a given project - used by assignee
   * pickers so a cross-workspace project member can still see the team. */
  @Get('for-project/:projectId/members')
  membersForProject(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.workspaces.listMembersForProject(scope, projectId);
  }

  @Get(':id')
  get(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.workspaces.getByIdScoped(scope, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Workspace')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateWorkspaceSchema)) input: UpdateWorkspaceInput,
  ) {
    return this.workspaces.update(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Workspace')
  async remove(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.workspaces.remove(scope, user.id, id);
    return { ok: true };
  }
}
