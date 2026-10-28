import { z } from 'zod';
import {
  type CreateCustomFieldDefinitionInput,
  type CustomFieldDefinition,
  customFieldDefinitionSchema,
  type CustomFieldValue,
  customFieldValueSchema,
  type ListCustomFieldDefinitionsQuery,
  type SetCustomFieldValueInput,
  type UpdateCustomFieldDefinitionInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const definitionListSchema = z.array(customFieldDefinitionSchema);
const valueListSchema = z.array(customFieldValueSchema);

export class CustomFieldsResource {
  constructor(private readonly http: HttpClient) {}

  listDefinitions(
    query?: Partial<ListCustomFieldDefinitionsQuery>,
  ): Promise<CustomFieldDefinition[]> {
    return this.http.get('/custom-field-definitions', definitionListSchema, query);
  }
  createDefinition(input: CreateCustomFieldDefinitionInput): Promise<CustomFieldDefinition> {
    return this.http.post('/custom-field-definitions', customFieldDefinitionSchema, input);
  }
  updateDefinition(
    id: string,
    input: UpdateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinition> {
    return this.http.patch(`/custom-field-definitions/${id}`, customFieldDefinitionSchema, input);
  }
  deleteDefinition(id: string) {
    return this.http.delete(`/custom-field-definitions/${id}`, okSchema);
  }

  listValues(entityId: string): Promise<CustomFieldValue[]> {
    return this.http.get('/custom-field-values', valueListSchema, { entityId });
  }
  /** Every TASK-field value on one project's tasks (list view columns). */
  listProjectTaskValues(projectId: string): Promise<CustomFieldValue[]> {
    return this.http.get('/custom-field-values', valueListSchema, { projectId });
  }
  setValue(input: SetCustomFieldValueInput): Promise<CustomFieldValue> {
    return this.http.post('/custom-field-values', customFieldValueSchema, input);
  }
  clearValue(id: string) {
    return this.http.delete(`/custom-field-values/${id}`, okSchema);
  }
}
