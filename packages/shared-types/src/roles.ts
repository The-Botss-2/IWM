import { z } from 'zod';

import { cuid } from './common/id.js';

/**
 * Configurable roles & permissions. The permission catalog itself lives in
 * `@botss/auth` (permissions.ts); these are the wire shapes.
 */

export const PermissionScope = z.enum(['company', 'workspace']);
export type PermissionScope = z.infer<typeof PermissionScope>;

export const RoleScope = z.enum(['COMPANY', 'WORKSPACE']);
export type RoleScope = z.infer<typeof RoleScope>;

const permissionKey = z.string().min(1).max(100);

export const effectivePermissionsSchema = z.object({
  company: z.array(z.string()),
  /** Permissions in the active workspace only. */
  workspace: z.array(z.string()),
});
export type EffectivePermissionsDto = z.infer<typeof effectivePermissionsSchema>;

export const permissionDefSchema = z.object({
  key: z.string(),
  scope: PermissionScope,
  group: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type PermissionDefDto = z.infer<typeof permissionDefSchema>;

export const permissionCatalogResponseSchema = z.object({
  permissions: z.array(permissionDefSchema),
});
export type PermissionCatalogResponse = z.infer<typeof permissionCatalogResponseSchema>;

/**
 * A role as listed in Settings > Roles. Presets come from code and carry
 * `preset: true` plus `presetKey` (a SystemRole or OWNER/ADMIN/MEMBER/VIEWER);
 * their `id` is `preset:<KEY>`. Custom roles are `Role` rows.
 */
export const roleSchema = z.object({
  id: z.string(),
  scope: RoleScope,
  name: z.string(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  basePreset: z.string().nullable(),
  preset: z.boolean(),
  presetKey: z.string().nullable(),
  /** Read-only in the UI (SUPER_ADMIN, ADMIN, and every preset). */
  locked: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});
export type RoleDto = z.infer<typeof roleSchema>;

export const listRolesResponseSchema = z.object({
  company: z.array(roleSchema),
  workspace: z.array(roleSchema),
});
export type ListRolesResponse = z.infer<typeof listRolesResponseSchema>;

export const createRoleSchema = z.object({
  scope: RoleScope,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(permissionKey).max(100),
  basePreset: z.string().max(40).nullable().optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(permissionKey).max(100).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const permissionOverrideSchema = z.object({
  permission: permissionKey,
  grant: z.boolean(),
});
export type PermissionOverrideDto = z.infer<typeof permissionOverrideSchema>;

/** Replace a user's overrides for one scope: company (workspaceId null) or one workspace. */
export const setPermissionOverridesSchema = z.object({
  workspaceId: cuid.nullable(),
  overrides: z.array(permissionOverrideSchema).max(100),
});
export type SetPermissionOverridesInput = z.infer<typeof setPermissionOverridesSchema>;

/** Assign a company role: a preset (systemRole, unchanged here) or a custom role. */
export const setCompanyRoleSchema = z.object({
  customRoleId: cuid.nullable(),
});
export type SetCompanyRoleInput = z.infer<typeof setCompanyRoleSchema>;

export const userPermissionsQuerySchema = z.object({
  workspaceId: cuid.optional(),
});
export type UserPermissionsQuery = z.infer<typeof userPermissionsQuerySchema>;

/** A user's role assignment and overrides, for the Users / Members editors. */
export const userPermissionsResponseSchema = z.object({
  userId: cuid,
  systemRole: z.string(),
  customRoleId: cuid.nullable(),
  /** Company overrides. */
  companyOverrides: z.array(permissionOverrideSchema),
  /** Overrides in the requested workspace (empty when none requested). */
  workspaceOverrides: z.array(permissionOverrideSchema),
  workspaceId: cuid.nullable(),
  /** The user's effective permissions (company + requested workspace). */
  effective: effectivePermissionsSchema,
});
export type UserPermissionsResponse = z.infer<typeof userPermissionsResponseSchema>;

export const rolesOkResponseSchema = z.object({ ok: z.literal(true) });
export type RolesOkResponse = z.infer<typeof rolesOkResponseSchema>;
