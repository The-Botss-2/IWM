import { z } from 'zod';
import {
  type CreateSprintInput,
  type MoveSprintTaskInput,
  type ReorderSprintTaskInput,
  sprintSchema,
  sprintWithStatsSchema,
  type UpdateSprintInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const sprintsListSchema = z.array(sprintWithStatsSchema);

export class SprintsResource {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string) {
    return this.http.get(`/projects/${projectId}/sprints`, sprintsListSchema);
  }
  create(projectId: string, input: CreateSprintInput) {
    return this.http.post(`/projects/${projectId}/sprints`, sprintSchema, input);
  }
  update(sprintId: string, input: UpdateSprintInput) {
    return this.http.patch(`/sprints/${sprintId}`, sprintSchema, input);
  }
  remove(sprintId: string) {
    return this.http.delete(`/sprints/${sprintId}`, okSchema);
  }
  start(sprintId: string) {
    return this.http.post(`/sprints/${sprintId}/start`, sprintSchema, {});
  }
  complete(sprintId: string) {
    return this.http.post(`/sprints/${sprintId}/complete`, sprintSchema, {});
  }
  addTask(sprintId: string, taskId: string) {
    return this.http.post(`/sprints/${sprintId}/tasks`, okSchema, { taskId });
  }
  removeTask(sprintId: string, taskId: string) {
    return this.http.delete(`/sprints/${sprintId}/tasks/${taskId}`, okSchema);
  }
  /** Reorder a task within a sprint by 0-based index. */
  reorderTask(sprintId: string, input: ReorderSprintTaskInput) {
    return this.http.patch(`/sprints/${sprintId}/reorder`, okSchema, input);
  }
  /** Move a task between two sprints (delete + recreate, server-side tx). */
  moveTask(input: MoveSprintTaskInput) {
    return this.http.post(`/sprints/move-task`, okSchema, input);
  }
}
