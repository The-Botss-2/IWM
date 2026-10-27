import { z } from 'zod';
import {
  type BulkTaskRequest,
  bulkTaskResponseSchema,
  type CreateTaskInput,
  type ListTasksQuery,
  listResponseSchema,
  type ReorderTaskInput,
  type Task,
  taskSchema,
  taskWithPeopleSchema,
  type UpdateTaskInput,
  taskPortalVisibilitySchema,
  type TaskPortalVisibility,
  type UpdateTaskPortalVisibilityInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const taskListResponseSchema = listResponseSchema(taskWithPeopleSchema);

export class TasksResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListTasksQuery>) {
    return this.http.get('/tasks', taskListResponseSchema, query);
  }
  create(input: CreateTaskInput): Promise<Task> {
    return this.http.post('/tasks', taskSchema, input);
  }
  update(id: string, input: UpdateTaskInput): Promise<Task> {
    return this.http.patch(`/tasks/${id}`, taskSchema, input);
  }
  reorder(id: string, input: ReorderTaskInput): Promise<Task> {
    return this.http.patch(`/tasks/${id}/reorder`, taskSchema, input);
  }
  bulk(input: BulkTaskRequest) {
    return this.http.post('/tasks/bulk', bulkTaskResponseSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/tasks/${id}`, okSchema);
  }
  /** Archive a task (soft delete). Surfaced in Archive view. */
  archive(id: string) {
    return this.http.post(`/tasks/${id}/archive`, taskSchema, {});
  }
  /** Restore a soft-deleted task. */
  restore(id: string) {
    return this.http.post(`/tasks/${id}/restore`, taskSchema, {});
  }
  /** List archived (soft-deleted or cancelled) tasks for a given project. */
  archived(projectId: string) {
    return this.http.get(`/projects/${projectId}/archived-tasks`, taskListResponseSchema);
  }

  /** Client portal: list this task for the project's client (marked mode). */
  updatePortalVisibility(
    id: string,
    input: UpdateTaskPortalVisibilityInput,
  ): Promise<TaskPortalVisibility> {
    return this.http.patch(`/tasks/${id}/portal-visibility`, taskPortalVisibilitySchema, input);
  }
}
