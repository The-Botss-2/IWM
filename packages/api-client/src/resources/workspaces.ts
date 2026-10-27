import { z } from 'zod';
import {
  type CreateWorkspaceInput,
  type InviteMemberInput,
  inviteMemberResponseSchema,
  listResponseSchema,
  type ListWorkspacesQuery,
  type UpdateMembershipInput,
  type UpdateWorkspaceInput,
  type Workspace,
  workspaceMembershipWithUserSchema,
  workspaceSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });

const workspaceListResponseSchema = listResponseSchema(workspaceSchema);
const membershipListSchema = z.array(workspaceMembershipWithUserSchema);

export class WorkspacesResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListWorkspacesQuery>): Promise<{
    items: Workspace[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    return this.http.get('/workspaces', workspaceListResponseSchema, query);
  }
  current() {
    return this.http.get('/workspaces/current', workspaceSchema);
  }
  create(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.http.post('/workspaces', workspaceSchema, input);
  }
  updateCurrent(input: UpdateWorkspaceInput) {
    return this.http.patch(`/workspaces/current`, workspaceSchema, input);
  }
  currentMembers() {
    return this.http.get('/workspaces/current/members', membershipListSchema);
  }
  inviteCurrentMember(input: InviteMemberInput) {
    return this.http.post('/workspaces/current/members', inviteMemberResponseSchema, input);
  }
  updateCurrentMember(membershipId: string, input: UpdateMembershipInput) {
    return this.http.patch(
      `/workspaces/current/members/${membershipId}`,
      workspaceMembershipWithUserSchema,
      input,
    );
  }
  removeCurrentMember(membershipId: string) {
    return this.http.delete(`/workspaces/current/members/${membershipId}`, okSchema);
  }
  /** Regenerate the invitation token for a pending membership. */
  resendInvitation(membershipId: string) {
    return this.http.post(
      `/workspaces/current/members/${membershipId}/resend-invite`,
      inviteMemberResponseSchema,
      {},
    );
  }
  /** Revoke a *pending* invitation - deletes membership + token. For
   * accepted members use `removeCurrentMember`. */
  revokeInvitation(membershipId: string) {
    return this.http.delete(
      `/workspaces/current/members/${membershipId}/invite`,
      okSchema,
    );
  }
  /** Members of the workspace owning the given project - works even when the
   * caller's current workspace is something different (e.g. an outside
   * collaborator whose only access is via project membership). */
  membersForProject(projectId: string) {
    return this.http.get(`/workspaces/for-project/${projectId}/members`, membershipListSchema);
  }
}
