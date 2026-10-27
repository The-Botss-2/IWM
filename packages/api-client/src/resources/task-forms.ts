import { z } from 'zod';
import {
  type CreateTaskFormInput,
  publicTaskFormSchema,
  type SubmitTaskFormInput,
  submitTaskFormResponseSchema,
  taskFormSchema,
  taskFormSubmissionSchema,
  type UpdateTaskFormInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const formsListSchema = z.array(taskFormSchema);
const submissionsListSchema = z.array(taskFormSubmissionSchema);

export class TaskFormsResource {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string) {
    return this.http.get(`/projects/${projectId}/forms`, formsListSchema);
  }
  create(projectId: string, input: CreateTaskFormInput) {
    return this.http.post(`/projects/${projectId}/forms`, taskFormSchema, input);
  }
  update(formId: string, input: UpdateTaskFormInput) {
    return this.http.patch(`/forms/${formId}`, taskFormSchema, input);
  }
  remove(formId: string) {
    return this.http.delete(`/forms/${formId}`, okSchema);
  }
  submissions(formId: string) {
    return this.http.get(`/forms/${formId}/submissions`, submissionsListSchema);
  }

  // Public - no auth
  publicGet(slug: string) {
    return this.http.get(`/forms/public/${encodeURIComponent(slug)}`, publicTaskFormSchema);
  }
  publicSubmit(slug: string, input: SubmitTaskFormInput) {
    return this.http.post(
      `/forms/public/${encodeURIComponent(slug)}/submit`,
      submitTaskFormResponseSchema,
      input,
    );
  }
}
