import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListUsersQuery, UpdateUserInput } from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async listInWorkspace(workspaceId: string, query: ListUsersQuery) {
    const where = {
      workspaceMemberships: { some: { workspaceId } },
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.user.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { name: 'asc' },
      }),
      this.prisma.client.user.count({ where }),
    ]);
    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize) || 1,
      },
    };
  }

  async getById(id: string) {
    const user = await this.prisma.client.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ title: 'User not found', status: 404 });
    return user;
  }

  /**
   * Same as `getById` but 404s unless the caller shares at least one workspace
   * OR one project with the target user. Prevents user-by-id from leaking
   * profile data across tenants.
   */
  async getByIdScoped(scope: UserScope, id: string) {
    if (id === scope.userId) return this.getById(id);

    const sharedMembership = await this.prisma.client.user.findFirst({
      where: {
        id,
        OR: [
          // Shares a workspace with the caller
          ...(scope.workspaceIds.length > 0
            ? [
                {
                  workspaceMemberships: {
                    some: { workspaceId: { in: scope.workspaceIds } },
                  },
                },
              ]
            : []),
          // Shares a project with the caller
          ...(scope.projectIds.length > 0
            ? [
                {
                  projectMemberships: {
                    some: { projectId: { in: scope.projectIds } },
                  },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (!sharedMembership) {
      throw new NotFoundException({ title: 'User not found', status: 404 });
    }
    return this.getById(id);
  }

  async updateMe(userId: string, input: UpdateUserInput) {
    // Whitelist explicitly so a future widening of UpdateUserInput cannot
    // expose `systemRole`, `organizationId`, `emailVerified`, `deletedAt`,
    // or any other privileged column to self-service mass assignment.
    return this.prisma.client.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      },
    });
  }
}
