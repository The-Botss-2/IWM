import { z } from 'zod';
import {
  type CreateProjectInput,
  createProjectSchema,
  type ListProjectsQuery,
  listResponseSchema,
  type Project,
  projectSchema,
  projectWithCreatorSchema,
  type UpdateProjectInput,
  projectPortalSettingsSchema,
  type ProjectPortalSettings,
  type UpdateProjectPortalInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });

const projectListResponseSchema = listResponseSchema(projectWithCreatorSchema);

export class ProjectsResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListProjectsQuery>) {
    return this.http.get('/projects', projectListResponseSchema, query);
  }
  get(id: string) {
    return this.http.get(`/projects/${id}`, projectWithCreatorSchema);
  }
  create(input: CreateProjectInput): Promise<Project> {
    return this.http.post('/projects', projectSchema, createProjectSchema.parse(input));
  }
  update(id: string, input: UpdateProjectInput): Promise<Project> {
    return this.http.patch(`/projects/${id}`, projectSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/projects/${id}`, okSchema);
  }

  /** Client portal: show the project, and all tasks or only marked ones. */
  updatePortal(id: string, input: UpdateProjectPortalInput): Promise<ProjectPortalSettings> {
    return this.http.patch(`/projects/${id}/portal`, projectPortalSettingsSchema, input);
  }
}
