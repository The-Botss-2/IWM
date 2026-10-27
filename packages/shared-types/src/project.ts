import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { ProjectStatus, ProjectVisibility, ProjectRole, TaskStatus } from './enums.js';
import { userSummarySchema } from './user.js';

/**
 * Per-project workflow tuning stored as JSON in `Project.workflowSettings`.
 * WIP limits map TaskStatus values to a positive integer; missing keys mean
 * "no limit". Kept open-ended so future tabs (custom statuses, etc.) can
 * extend without a new column.
 */
export const projectWorkflowSettingsSchema = z
  .object({
    wipLimits: z.record(TaskStatus, z.number().int().positive()).optional(),
  })
  .strict();
export type ProjectWorkflowSettings = z.infer<typeof projectWorkflowSettingsSchema>;

export const projectSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  clientId: cuid.nullable(),
  createdById: cuid,
  name: z.string().min(1).max(120),
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Project key must be uppercase letters/digits, starting with a letter'),
  description: z.string().nullable(),
  status: ProjectStatus,
  visibility: ProjectVisibility,
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex string').nullable(),
  workflowSettings: projectWorkflowSettingsSchema,
  /** Client portal: whether the linked client's people see this project
   *  (absent reads as true). Read-only here; changed through
   *  `PATCH /projects/:id/portal`. Optional, not defaulted, so the SDK's
   *  input and output types stay identical. */
  portalVisible: z.boolean().optional(),
  /** Client portal task list: every task (true) or only marked tasks
   *  (absent reads as false). */
  portalShowAllTasks: z.boolean().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectWithCreatorSchema = projectSchema.extend({
  createdBy: userSummarySchema,
  /**
   * Number of explicit ProjectMemberships. Optional because only the list
   * endpoint computes it - the detail endpoint returns the full `memberships`
   * array instead. Drives the "who can see this" column on the workspace
   * project-access screen, where fetching each project's member list would
   * mean one request per row.
   */
  memberCount: z.number().int().nonnegative().optional(),
});
export type ProjectWithCreator = z.infer<typeof projectWithCreatorSchema>;

/** Empty-string-tolerant optional date - see notes in task.ts. HTML date
 *  inputs emit '' when cleared, which `z.coerce.date()` cannot parse. */
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.date().optional(),
);

/** Project key is optional on create: blank/whitespace is treated as "omitted"
 *  so the server auto-generates a unique key from the project name. When the
 *  user does supply one, it's validated exactly like `projectSchema.key`. */
const optionalKey = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z
    .string()
    .min(2)
    .max(10)
    .regex(
      /^[A-Z][A-Z0-9]*$/,
      'Project key must be uppercase letters/digits, starting with a letter',
    )
    .optional(),
);

export const createProjectSchema = projectSchema
  .pick({ name: true })
  .extend({
    key: optionalKey,
    clientId: cuid.optional(),
    description: z.string().optional(),
    status: ProjectStatus.optional(),
    visibility: ProjectVisibility.optional(),
    startDate: optionalDate,
    dueDate: optionalDate,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial().extend({
  // Key changes are allowed (rare); will collide on (workspaceId, key) unique.
  clientId: cuid.nullable().optional(),
  workflowSettings: projectWorkflowSettingsSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
  status: ProjectStatus.optional(),
  clientId: cuid.optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'dueDate']).default('updatedAt'),
  order: sortOrderSchema,
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/**
 * Per-project notification preferences stored on `ProjectMembership.notificationSettings`.
 * Open-ended JSON so individual users can opt in/out of digest categories
 * without a column-per-channel.
 */
export const projectNotificationSettingsSchema = z
  .object({
    digestFrequency: z.enum(['off', 'daily', 'weekly']).optional(),
    mentions: z.boolean().optional(),
    statusChanges: z.boolean().optional(),
    dueDateReminders: z.boolean().optional(),
  })
  .strict();
export type ProjectNotificationSettings = z.infer<typeof projectNotificationSettingsSchema>;

// Project membership
export const projectMembershipSchema = z.object({
  id: cuid,
  projectId: cuid,
  userId: cuid,
  role: ProjectRole,
  abilities: z.unknown().nullable(),
  notificationSettings: projectNotificationSettingsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ProjectMembership = z.infer<typeof projectMembershipSchema>;

export const projectMembershipWithUserSchema = projectMembershipSchema.extend({
  user: userSummarySchema,
});
export type ProjectMembershipWithUser = z.infer<typeof projectMembershipWithUserSchema>;

/**
 * What a per-member override on `ProjectMembership.abilities` may talk
 * about: the project-scoped subjects the project-role layer of the ability
 * factory grants (`packages/auth/src/ability.ts`, Layer 2), and plain CRUD
 * actions. Deliberately NOT allowed: `manage`, `all`, `ProjectMembership`
 * (who manages the team is a role decision, not an override), and every
 * workspace- or org-level subject (finance, HR, CRM, users). Otherwise any
 * project member editor could mint `manage all` for anyone.
 */
export const PROJECT_ABILITY_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export const PROJECT_ABILITY_SUBJECTS = ['Project', 'Task', 'Document'] as const;
export const ProjectAbilityAction = z.enum(PROJECT_ABILITY_ACTIONS);
export type ProjectAbilityAction = z.infer<typeof ProjectAbilityAction>;
export const ProjectAbilitySubject = z.enum(PROJECT_ABILITY_SUBJECTS);
export type ProjectAbilitySubject = z.infer<typeof ProjectAbilitySubject>;

/**
 * A single CASL rule override stored on `ProjectMembership.abilities`.
 * `conditions` is accepted for wire compatibility but REPLACED: the server
 * (and the ability factory, for rows stored before this rule) always pins
 * the rule to the membership's own project (`{ projectId }`, or `{ id }` for
 * the Project subject). See `scopeProjectAbilityRules` in @botss/auth.
 */
export const projectAbilityRuleSchema = z
  .object({
    action: z.union([ProjectAbilityAction, z.array(ProjectAbilityAction).min(1).max(4)]),
    subject: z.union([ProjectAbilitySubject, z.array(ProjectAbilitySubject).min(1).max(3)]),
    conditions: z.record(z.unknown()).optional(),
    fields: z.array(z.string().min(1).max(64)).max(50).optional(),
    inverted: z.boolean().optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();
export type ProjectAbilityRule = z.infer<typeof projectAbilityRuleSchema>;

export const projectAbilityRulesSchema = z.array(projectAbilityRuleSchema).max(50);
export type ProjectAbilityRules = z.infer<typeof projectAbilityRulesSchema>;

export const addProjectMemberSchema = z.object({
  userId: cuid,
  role: ProjectRole,
  abilities: projectAbilityRulesSchema.optional(),
});
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;

export const updateProjectMemberSchema = z.object({
  role: ProjectRole.optional(),
  abilities: projectAbilityRulesSchema.optional(),
});
export type UpdateProjectMemberInput = z.infer<typeof updateProjectMemberSchema>;
