import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createProjectSchema,
  type CreateProjectInput,
  cuid,
  listProjectsQuerySchema,
  type ListProjectsQuery,
  updateProjectSchema,
  type UpdateProjectInput,
} from '@botss/shared-types';

import type { AppAbility } from '@botss/auth';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { RequestAbility } from '../common/decorators/request-ability.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequireAbility('read', 'Project')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listProjectsQuerySchema)) q: ListProjectsQuery,
  ) {
    return this.projects.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Project')
  create(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createProjectSchema)) input: CreateProjectInput,
  ) {
    return this.projects.create(workspaceId, user.id, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Project')
  get(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.projects.get(scope, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Project')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) input: UpdateProjectInput,
  ) {
    return this.projects.update(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Project')
  async remove(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.projects.remove(scope, ability, id);
    return { ok: true };
  }

  @Get(':id/summary')
  @RequireAbility('read', 'Project')
  summary(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.projects.summary(scope, id);
  }

  @Get(':id/archived-tasks')
  @RequireAbility('read', 'Project')
  archivedTasks(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.projects.listArchivedTasks(scope, id);
  }

  @Post(':id/archive')
  @RequireAbility('update', 'Project')
  archive(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.projects.archive(scope, id);
  }

  @Post(':id/restore')
  @RequireAbility('update', 'Project')
  restore(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.projects.restore(scope, id);
  }
}
