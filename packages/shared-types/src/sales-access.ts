import { z } from 'zod';

/**
 * Whether the signed-in user should be offered the Leads / Clients surfaces at
 * all, in the workspace they currently have active.
 *
 * Access comes from one of two places, and the client can't work either out on
 * its own: a sales systemRole or workspace OWNER/ADMIN role grants everything
 * (`fullAccess`), and otherwise having at least one record assigned to you
 * grants that section. Since assignment lives in the database, the server
 * answers this and the nav follows.
 */
export const salesAccessSchema = z.object({
  /** Sales systemRole (ADMIN / SUPER_ADMIN / HR) or workspace OWNER / ADMIN. */
  fullAccess: z.boolean(),
  /** Show the Leads tab: full access, or at least one lead assigned to me. */
  leads: z.boolean(),
  /** Show the Clients tab: full access, or at least one client assigned to me. */
  clients: z.boolean(),
});
export type SalesAccess = z.infer<typeof salesAccessSchema>;
