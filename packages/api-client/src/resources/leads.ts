import { z } from 'zod';
import {
  type ConvertLeadInput,
  type CreateLeadInput,
  type Lead,
  leadSchema,
  leadWithOwnerSchema,
  type ListLeadsQuery,
  listResponseSchema,
  type UpdateLeadInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const leadListResponseSchema = listResponseSchema(leadWithOwnerSchema);

export class LeadsResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListLeadsQuery>) {
    return this.http.get('/leads', leadListResponseSchema, query);
  }
  create(input: CreateLeadInput): Promise<Lead> {
    return this.http.post('/leads', leadSchema, input);
  }
  update(id: string, input: UpdateLeadInput): Promise<Lead> {
    return this.http.patch(`/leads/${id}`, leadSchema, input);
  }
  convert(id: string, input: ConvertLeadInput) {
    return this.http.post(`/leads/${id}/convert`, leadSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/leads/${id}`, okSchema);
  }
}
