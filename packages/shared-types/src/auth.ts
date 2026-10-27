import { z } from 'zod';

import { cuid } from './common/id.js';
import { ProjectRole, WorkspaceRole } from './enums.js';
import { effectivePermissionsSchema } from './roles.js';
import { supportSessionInfoSchema } from './support-access.js';
import { userSchema } from './user.js';

export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * When true (the default), the session cookie is persistent and lives for
   * the full server-side `session.expiresIn` (30 days) so desktop / mobile
   * webviews stay signed in across restarts. When false, Better Auth issues
   * a browser-session cookie that clears when the app closes.
   */
  rememberMe: z.boolean().optional().default(true),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(128),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** What the API returns on `/auth/me` - current user + memberships needed to build CASL ability. */
export const sessionContextSchema = z.object({
  user: userSchema,
  currentWorkspaceId: cuid.nullable(),
  workspaceMemberships: z.array(
    z.object({
      workspaceId: cuid,
      role: WorkspaceRole,
    }),
  ),
  projectMemberships: z.array(
    z.object({
      projectId: cuid,
      workspaceId: cuid,
      role: ProjectRole,
      abilities: z.unknown().nullable(),
    }),
  ),
  /** Effective permissions (company + active workspace). Optional so older
   *  API builds still parse. */
  permissions: effectivePermissionsSchema.optional(),
  /** Set while a platform operator browses this organization in a read only
   *  support session. Absent / null on every normal request. */
  support: supportSessionInfoSchema.nullable().optional(),
});
export type SessionContext = z.infer<typeof sessionContextSchema>;
