import { z } from 'zod';
import {
  type AddProjectMemberInput,
  addProjectMemberSchema,
  projectMembershipSchema,
  projectMembershipWithUserSchema,
  type UpdateProjectMemberInput,
  updateProjectMemberSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const membershipListSchema = z.array(projectMembershipWithUserSchema);

export class ProjectMembersResource {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string) {
    return this.http.get(`/projects/${projectId}/members`, membershipListSchema);
  }
  add(projectId: string, input: AddProjectMemberInput) {
    return this.http.post(
      `/projects/${projectId}/members`,
      projectMembershipSchema,
      addProjectMemberSchema.parse(input),
    );
  }
  update(projectId: string, id: string, input: UpdateProjectMemberInput) {
    return this.http.patch(
      `/projects/${projectId}/members/${id}`,
      projectMembershipSchema,
      updateProjectMemberSchema.parse(input),
    );
  }
  remove(projectId: string, id: string) {
    return this.http.delete(`/projects/${projectId}/members/${id}`, okSchema);
  }
}
