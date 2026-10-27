import { z } from 'zod';
import {
  type CreateTodoInput,
  type TodoWithRefs,
  todoWithRefsSchema,
  type UpdateTodoInput,
  type TodoDueFilter,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const listResponseSchema = z.object({ items: z.array(todoWithRefsSchema) });
const okSchema = z.object({ ok: z.literal(true) });

export interface ListTodosArgs {
  done?: boolean;
  dueDate?: TodoDueFilter;
  limit?: number;
  /// 'org' aggregates across every workspace in the caller's org.
  aggregate?: 'org';
  workspaceId?: string;
  projectId?: string;
}

export class TodosResource {
  constructor(private readonly http: HttpClient) {}

  list(args: ListTodosArgs = {}): Promise<{ items: TodoWithRefs[] }> {
    const query: Record<string, unknown> = {};
    if (args.done !== undefined) query.done = String(args.done);
    if (args.dueDate) query.dueDate = args.dueDate;
    if (args.limit) query.limit = args.limit;
    if (args.aggregate) query.aggregate = args.aggregate;
    if (args.workspaceId) query.workspaceId = args.workspaceId;
    if (args.projectId) query.projectId = args.projectId;
    return this.http.get('/todos', listResponseSchema, query);
  }

  create(input: CreateTodoInput): Promise<TodoWithRefs> {
    return this.http.post('/todos', todoWithRefsSchema, input);
  }

  update(id: string, input: UpdateTodoInput): Promise<TodoWithRefs> {
    return this.http.patch(`/todos/${id}`, todoWithRefsSchema, input);
  }

  remove(id: string) {
    return this.http.delete(`/todos/${id}`, okSchema);
  }
}
