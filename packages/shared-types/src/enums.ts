import { z } from 'zod';

/* eslint-disable @typescript-eslint/no-redeclare -- value/type pairs share names by design */

export const WorkspaceRole = z.enum([
  'OWNER',
  'ADMIN',
  'MEMBER',
  'VIEWER',
  'CLIENT',
  // Phase 4 - appended only; never reorder or remove existing values.
  'MANAGER',
  'EDITOR',
]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const ProjectRole = z.enum(['PROJECT_LEAD', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER']);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const ProjectStatus = z.enum(['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProjectVisibility = z.enum(['PRIVATE', 'WORKSPACE', 'PUBLIC']);
export type ProjectVisibility = z.infer<typeof ProjectVisibility>;

export const TaskStatus = z.enum([
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const LeadStage = z.enum([
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
]);
export type LeadStage = z.infer<typeof LeadStage>;

export const LeadSource = z.enum([
  'WEBSITE',
  'REFERRAL',
  'COLD_OUTREACH',
  'EVENT',
  'SOCIAL',
  'PARTNER',
  'OTHER',
]);
export type LeadSource = z.infer<typeof LeadSource>;

export const ClientStatus = z.enum(['PROSPECT', 'ACTIVE', 'PAUSED', 'CHURNED']);
export type ClientStatus = z.infer<typeof ClientStatus>;

export const DocumentVisibility = z.enum(['PRIVATE', 'PROJECT', 'WORKSPACE', 'PUBLIC_LINK']);
export type DocumentVisibility = z.infer<typeof DocumentVisibility>;

export const DocumentPermission = z.enum(['READ', 'WRITE']);
export type DocumentPermission = z.infer<typeof DocumentPermission>;

export const FileKind = z.enum([
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'PDF',
  'DOC',
  'SHEET',
  'SLIDE',
  'ARCHIVE',
  'OTHER',
]);
export type FileKind = z.infer<typeof FileKind>;

// E-signature (mirrors the Prisma enums of the same names)
export const SignatureRequestStatus = z.enum([
  'DRAFT',
  'SENT',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
]);
export type SignatureRequestStatus = z.infer<typeof SignatureRequestStatus>;

export const SignerStatus = z.enum(['PENDING', 'VIEWED', 'SIGNED', 'DECLINED']);
export type SignerStatus = z.infer<typeof SignerStatus>;

export const SignatureMethod = z.enum(['DRAWN', 'TYPED']);
export type SignatureMethod = z.infer<typeof SignatureMethod>;

export const SignatureFieldKind = z.enum(['SIGNATURE', 'DATE']);
export type SignatureFieldKind = z.infer<typeof SignatureFieldKind>;

export const SignatureEventKind = z.enum([
  'CREATED',
  'SENT',
  'VIEWED',
  'SIGNED',
  'DECLINED',
  'RESENT',
  'CANCELLED',
  'COMPLETED',
  'SEAL_FAILED',
]);
export type SignatureEventKind = z.infer<typeof SignatureEventKind>;

// Phase 3 enums
export const SprintStatus = z.enum(['PLANNED', 'ACTIVE', 'COMPLETED']);
export type SprintStatus = z.infer<typeof SprintStatus>;

export const GoalStatus = z.enum([
  'ON_TRACK',
  'AT_RISK',
  'OFF_TRACK',
  'COMPLETED',
  'ARCHIVED',
]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const KeyResultMetric = z.enum(['NUMBER', 'PERCENT', 'CURRENCY', 'BOOLEAN']);
export type KeyResultMetric = z.infer<typeof KeyResultMetric>;

export const SavedViewScope = z.enum(['TASKS', 'PROJECT']);
export type SavedViewScope = z.infer<typeof SavedViewScope>;

export const TaskFormFieldType = z.enum([
  'text',
  'textarea',
  'email',
  'number',
  'select',
  'checkbox',
]);
export type TaskFormFieldType = z.infer<typeof TaskFormFieldType>;

// Phase 2 Step F - custom fields
export const CustomFieldScope = z.enum(['PROJECT', 'TASK', 'LEAD', 'CLIENT']);
export type CustomFieldScope = z.infer<typeof CustomFieldScope>;

export const CustomFieldType = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
  'URL',
  'USER',
]);
export type CustomFieldType = z.infer<typeof CustomFieldType>;
