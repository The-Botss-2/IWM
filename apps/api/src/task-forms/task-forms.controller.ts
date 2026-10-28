import { Body, Controller, Delete, Get, Headers, Ip, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  createTaskFormSchema,
  type CreateTaskFormInput,
  cuid,
  submitTaskFormSchema,
  type SubmitTaskFormInput,
  updateTaskFormSchema,
  type UpdateTaskFormInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TaskFormsService } from './task-forms.service';

const publicSlug = z.string().regex(/^[a-f0-9]{16}$/);

@Controller()
export class TaskFormsController {
  constructor(private readonly forms: TaskFormsService) {}

  @Get('projects/:projectId/forms')
  @RequireAbility('read', 'Project')
  list(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.forms.list(scope, projectId);
  }

  @Post('projects/:projectId/forms')
  @RequireAbility('update', 'Project')
  create(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Body(new ZodValidationPipe(createTaskFormSchema)) input: CreateTaskFormInput,
  ) {
    return this.forms.create(scope, user.id, projectId, input);
  }

  @Get('forms/:id')
  @RequireAbility('read', 'Project')
  get(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.forms.get(scope, id);
  }

  @Patch('forms/:id')
  @RequireAbility('update', 'Project')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateTaskFormSchema)) input: UpdateTaskFormInput,
  ) {
    return this.forms.update(scope, id, input);
  }

  @Delete('forms/:id')
  @RequireAbility('update', 'Project')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.forms.remove(scope, id);
    return { ok: true };
  }

  @Get('forms/:id/submissions')
  @RequireAbility('read', 'Project')
  submissions(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.forms.submissions(scope, id);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  @Get('forms/public/:slug')
  @Public()
  publicGet(@Param('slug', new ZodValidationPipe(publicSlug)) slug: string) {
    return this.forms.publicGet(slug);
  }

  @Post('forms/public/:slug/submit')
  @Public()
  publicSubmit(
    @Param('slug', new ZodValidationPipe(publicSlug)) slug: string,
    @Body(new ZodValidationPipe(submitTaskFormSchema)) input: SubmitTaskFormInput,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.forms.publicSubmit({
      slug,
      input,
      ip: ip ?? 'unknown',
      userAgent: userAgent ?? null,
    });
  }
}
