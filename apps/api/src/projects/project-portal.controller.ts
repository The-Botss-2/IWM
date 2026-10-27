import { Body, Controller, Param, Patch } from '@nestjs/common';
import {
  cuid,
  updateProjectPortalSchema,
  updateTaskPortalVisibilitySchema,
  type ProjectPortalSettings,
  type TaskPortalVisibility,
  type UpdateProjectPortalInput,
  type UpdateTaskPortalVisibilityInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ProjectPortalService } from './project-portal.service';

/**
 * Staff-side client portal switches. `update Project` is the coarse gate;
 * the service requires a workspace owner/admin, an org admin or the lead.
 */
@Controller()
export class ProjectPortalController {
  constructor(private readonly portal: ProjectPortalService) {}

  @Patch('projects/:id/portal')
  @RequireAbility('update', 'Project')
  updateProject(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateProjectPortalSchema)) input: UpdateProjectPortalInput,
  ): Promise<ProjectPortalSettings> {
    return this.portal.updateProject(scope, id, input);
  }

  @Patch('tasks/:id/portal-visibility')
  @RequireAbility('update', 'Project')
  updateTask(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateTaskPortalVisibilitySchema))
    input: UpdateTaskPortalVisibilityInput,
  ): Promise<TaskPortalVisibility> {
    return this.portal.updateTask(scope, id, input);
  }
}
