import { z } from 'zod';
import {
  type Comment,
  commentSchema,
  commentListResponseSchema,
  type CreateCommentInput,
  type ListCommentsQuery,
  type UpdateCommentInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });

export class CommentsResource {
  constructor(private readonly http: HttpClient) {}

  list(taskId: string, query?: Partial<ListCommentsQuery>) {
    return this.http.get(`/tasks/${taskId}/comments`, commentListResponseSchema, query);
  }
  create(taskId: string, input: CreateCommentInput): Promise<Comment> {
    return this.http.post(`/tasks/${taskId}/comments`, commentSchema, input);
  }
  update(commentId: string, input: UpdateCommentInput): Promise<Comment> {
    return this.http.patch(`/comments/${commentId}`, commentSchema, input);
  }
  remove(commentId: string) {
    return this.http.delete(`/comments/${commentId}`, okSchema);
  }
}
