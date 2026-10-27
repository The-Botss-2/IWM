import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  addProjectMemberSchema,
  type AddProjectMemberInput,
  cuid,
  updateProjectMemberSchema,
  type UpdateProjectMemberInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ProjectMembersService } from './project-members.service';

@Controller('projects/:projectId/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  @Get()
  @RequireAbility('read', 'ProjectMembership')
  list(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.members.list(scope, projectId);
  }

  @Post()
  @RequireAbility('create', 'ProjectMembership')
  add(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Body(new ZodValidationPipe(addProjectMemberSchema)) input: AddProjectMemberInput,
  ) {
    return this.members.add(scope, projectId, input);
  }

  @Patch(':id')
  @RequireAbility('update', 'ProjectMembership')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateProjectMemberSchema)) input: UpdateProjectMemberInput,
  ) {
    return this.members.update(scope, projectId, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'ProjectMembership')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.members.remove(scope, projectId, id);
    return { ok: true };
  }
}
