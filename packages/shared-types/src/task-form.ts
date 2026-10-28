import { z } from 'zod';

import { cuid } from './common/id.js';
import { TaskFormFieldType, TaskPriority, TaskStatus } from './enums.js';

/** One field definition inside a TaskForm. */
export const taskFormFieldSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  type: TaskFormFieldType,
  required: z.boolean(),
  /** Options for select fields. Empty for other types. */
  options: z.array(z.string().min(1).max(200)).optional(),
  /** Helper text shown under the label. */
  description: z.string().max(500).optional(),
});
export type TaskFormField = z.infer<typeof taskFormFieldSchema>;

export const taskFormFieldsSchema = z.array(taskFormFieldSchema);

export const taskFormSchema = z.object({
  id: cuid,
  projectId: cuid,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  isPublic: z.boolean(),
  publicSlug: z.string().nullable(),
  fields: taskFormFieldsSchema,
  defaultStatus: TaskStatus,
  defaultPriority: TaskPriority,
  defaultAssigneeId: cuid.nullable(),
  createdById: cuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type TaskForm = z.infer<typeof taskFormSchema>;

export const createTaskFormSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  fields: taskFormFieldsSchema,
  defaultStatus: TaskStatus,
  defaultPriority: TaskPriority,
  defaultAssigneeId: cuid.optional(),
  isPublic: z.boolean(),
});
export type CreateTaskFormInput = z.infer<typeof createTaskFormSchema>;

export const updateTaskFormSchema = createTaskFormSchema.partial();
export type UpdateTaskFormInput = z.infer<typeof updateTaskFormSchema>;

/** Public payload returned by GET /forms/:slug - only fields the visitor needs. */
export const publicTaskFormSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  fields: taskFormFieldsSchema,
  projectName: z.string(),
  projectKey: z.string(),
});
export type PublicTaskForm = z.infer<typeof publicTaskFormSchema>;

export const submitTaskFormSchema = z.object({
  /** Map of field id → value. Booleans for checkboxes, strings/numbers for others.
   *  Bounded here so an anonymous visitor cannot store an arbitrarily large
   *  blob; the API additionally drops keys that are not fields of the form. */
  payload: z
    .record(z.string().max(80), z.union([z.string().max(5000), z.number(), z.boolean()]))
    .refine((p) => Object.keys(p).length <= 100, {
      message: 'Too many fields in submission',
    }),
  submittedByEmail: z.string().email().optional(),
});
export type SubmitTaskFormInput = z.infer<typeof submitTaskFormSchema>;

export const submitTaskFormResponseSchema = z.object({
  ok: z.literal(true),
  /** `<project.key>-<short-id>` for the receipt page. */
  reference: z.string(),
});
export type SubmitTaskFormResponse = z.infer<typeof submitTaskFormResponseSchema>;

export const taskFormSubmissionSchema = z.object({
  id: cuid,
  formId: cuid,
  taskId: cuid.nullable(),
  payload: z.record(z.string(), z.unknown()),
  submittedByEmail: z.string().nullable(),
  submittedAt: z.coerce.date(),
});
export type TaskFormSubmission = z.infer<typeof taskFormSubmissionSchema>;
