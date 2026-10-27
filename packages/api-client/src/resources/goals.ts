import { z } from 'zod';
import {
  type CreateGoalInput,
  type CreateGoalUpdateInput,
  type CreateKeyResultInput,
  goalSchema,
  goalUpdateSchema,
  goalWithDetailsSchema,
  keyResultSchema,
  type UpdateGoalInput,
  type UpdateKeyResultInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const goalsListSchema = z.array(goalWithDetailsSchema);
const krListSchema = z.array(keyResultSchema);
const updatesListSchema = z.array(goalUpdateSchema);

export class GoalsResource {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string) {
    return this.http.get(`/projects/${projectId}/goals`, goalsListSchema);
  }
  create(projectId: string, input: CreateGoalInput) {
    return this.http.post(`/projects/${projectId}/goals`, goalSchema, input);
  }
  update(goalId: string, input: UpdateGoalInput) {
    return this.http.patch(`/goals/${goalId}`, goalSchema, input);
  }
  remove(goalId: string) {
    return this.http.delete(`/goals/${goalId}`, okSchema);
  }
  keyResults(goalId: string) {
    return this.http.get(`/goals/${goalId}/key-results`, krListSchema);
  }
  createKeyResult(goalId: string, input: CreateKeyResultInput) {
    return this.http.post(`/goals/${goalId}/key-results`, keyResultSchema, input);
  }
  updateKeyResult(krId: string, input: UpdateKeyResultInput) {
    return this.http.patch(`/key-results/${krId}`, keyResultSchema, input);
  }
  removeKeyResult(krId: string) {
    return this.http.delete(`/key-results/${krId}`, okSchema);
  }
  updates(goalId: string) {
    return this.http.get(`/goals/${goalId}/updates`, updatesListSchema);
  }
  createUpdate(goalId: string, input: CreateGoalUpdateInput) {
    return this.http.post(`/goals/${goalId}/updates`, goalUpdateSchema, input);
  }
}
