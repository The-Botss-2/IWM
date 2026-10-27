import { z } from 'zod';
import {
  type CreateSavedViewInput,
  savedViewSchema,
  type UpdateSavedViewInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const savedViewsListSchema = z.array(savedViewSchema);

export class SavedViewsResource {
  constructor(private readonly http: HttpClient) {}

  list(projectId: string) {
    return this.http.get(`/projects/${projectId}/saved-views`, savedViewsListSchema);
  }
  create(projectId: string, input: CreateSavedViewInput) {
    return this.http.post(`/projects/${projectId}/saved-views`, savedViewSchema, input);
  }
  update(id: string, input: UpdateSavedViewInput) {
    return this.http.patch(`/saved-views/${id}`, savedViewSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/saved-views/${id}`, okSchema);
  }
}
