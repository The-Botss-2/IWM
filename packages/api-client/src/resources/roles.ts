import {
  type CreateRoleInput,
  type ListRolesResponse,
  type PermissionCatalogResponse,
  type RoleDto,
  type RolesOkResponse,
  type SetCompanyRoleInput,
  type SetPermissionOverridesInput,
  type UpdateRoleInput,
  type UserPermissionsResponse,
  listRolesResponseSchema,
  permissionCatalogResponseSchema,
  roleSchema,
  rolesOkResponseSchema,
  userPermissionsResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/** Configurable roles & permissions (Settings > Roles, Users, Members). */
export class RolesResource {
  constructor(private readonly http: HttpClient) {}

  catalog(): Promise<PermissionCatalogResponse> {
    return this.http.get('/roles/catalog', permissionCatalogResponseSchema);
  }

  list(): Promise<ListRolesResponse> {
    return this.http.get('/roles', listRolesResponseSchema);
  }

  create(input: CreateRoleInput): Promise<RoleDto> {
    return this.http.post('/roles', roleSchema, input);
  }

  update(id: string, input: UpdateRoleInput): Promise<RoleDto> {
    return this.http.patch(`/roles/${id}`, roleSchema, input);
  }

  remove(id: string): Promise<RolesOkResponse> {
    return this.http.delete(`/roles/${id}`, rolesOkResponseSchema);
  }

  userPermissions(userId: string, workspaceId?: string): Promise<UserPermissionsResponse> {
    return this.http.get(
      `/roles/users/${userId}`,
      userPermissionsResponseSchema,
      workspaceId ? { workspaceId } : undefined,
    );
  }

  setCompanyRole(userId: string, input: SetCompanyRoleInput): Promise<UserPermissionsResponse> {
    return this.http.put(`/roles/users/${userId}/company-role`, userPermissionsResponseSchema, input);
  }

  setOverrides(userId: string, input: SetPermissionOverridesInput): Promise<UserPermissionsResponse> {
    return this.http.put(`/roles/users/${userId}/overrides`, userPermissionsResponseSchema, input);
  }
}
