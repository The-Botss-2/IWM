import { z } from 'zod';

import { cuid } from './common/id.js';
import { CustomFieldScope, CustomFieldType } from './enums.js';

/**
 * Custom field definition (Phase 2 Step F).
 *
 * Scope-rules:
 *   - `scope === 'PROJECT'` → `projectId` may be present (single-project) or null
 *     (workspace-wide override of project metadata).
 *   - `scope === 'TASK'` → `projectId` is required (tasks live inside a project).
 *   - `scope === 'LEAD' | 'CLIENT'` → `projectId` must be null (those entities
 *     don't belong to a project).
 *
 * Validation of those rules lives in the API service, not here, because the
 * shared type also needs to round-trip server responses regardless of scope.
 */

const optionSchema = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});
export type CustomFieldOption = z.infer<typeof optionSchema>;

export const customFieldDefinitionSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  scope: CustomFieldScope,
  projectId: cuid.nullable(),
  name: z.string().min(1).max(120),
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'key must be lowercase letters / digits / underscores'),
  type: CustomFieldType,
  options: z.array(optionSchema).nullable(),
  required: z.boolean(),
  position: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;

export const createCustomFieldDefinitionSchema = z.object({
  scope: CustomFieldScope,
  projectId: cuid.nullable().optional(),
  name: z.string().min(1).max(120),
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  type: CustomFieldType,
  options: z.array(optionSchema).optional(),
  required: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});
export type CreateCustomFieldDefinitionInput = z.infer<typeof createCustomFieldDefinitionSchema>;

export const updateCustomFieldDefinitionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  options: z.array(optionSchema).nullable().optional(),
  required: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});
export type UpdateCustomFieldDefinitionInput = z.infer<typeof updateCustomFieldDefinitionSchema>;

export const listCustomFieldDefinitionsQuerySchema = z.object({
  scope: CustomFieldScope.optional(),
  projectId: cuid.optional(),
});
export type ListCustomFieldDefinitionsQuery = z.infer<typeof listCustomFieldDefinitionsQuerySchema>;

/**
 * Stored value payload - the shape varies by definition.type. Validation of the
 * concrete payload against the definition lives in the service layer where we
 * know which definition was loaded; here we accept the union of all permitted
 * leaves.
 */
const customFieldValuePayloadSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const customFieldValueSchema = z.object({
  id: cuid,
  definitionId: cuid,
  entityId: cuid,
  value: customFieldValuePayloadSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

export const setCustomFieldValueSchema = z.object({
  definitionId: cuid,
  entityId: cuid,
  value: customFieldValuePayloadSchema,
});
export type SetCustomFieldValueInput = z.infer<typeof setCustomFieldValueSchema>;

/**
 * Exactly one of: `entityId` (the values of one project or task) or
 * `projectId` (every TASK-field value on that project's tasks, for the list
 * view's columns).
 */
export const listCustomFieldValuesQuerySchema = z
  .object({
    entityId: cuid.optional(),
    projectId: cuid.optional(),
  })
  .refine((q) => Boolean(q.entityId) !== Boolean(q.projectId), {
    message: 'Pass exactly one of entityId or projectId.',
  });
export type ListCustomFieldValuesQuery = z.infer<typeof listCustomFieldValuesQuerySchema>;
