import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { cuid } from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { requireWorkspace } from './serialize';

const searchQuery = z.object({ q: z.string().max(120).optional() });
const sprintQuery = z.object({ projectId: cuid });
const taskQuery = z.object({ projectId: cuid, q: z.string().max(120).optional() });

/**
 * Thin read-only pickers for the contract / milestone / expense forms.
 *
 * They predate FINANCE joining `hasFullSalesAccess` (2026-10-06), when
 * `/clients` returned an empty list for a finance manager. Kept because they
 * return names and ids only, gated on `read Contract`, which is all the
 * forms need.
 */
@Controller('finance/pickers')
export class FinancePickersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('projects')
  @RequireAbility('read', 'Contract')
  async projects(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(searchQuery)) q: { q?: string },
  ) {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.project.findMany({
      where: {
        workspaceId,
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
      select: {
        id: true,
        name: true,
        key: true,
        clientId: true,
        client: { select: { name: true } },
      },
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        // Lets the contract form auto-fill the client when a project is picked.
        clientId: p.clientId,
        clientName: p.client?.name ?? null,
      })),
    };
  }

  @Get('clients')
  @RequireAbility('read', 'Contract')
  async clients(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(searchQuery)) q: { q?: string },
  ) {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.client.findMany({
      where: {
        workspaceId,
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
      select: { id: true, name: true, email: true },
    });
    return { items: rows };
  }

  @Get('sprints')
  @RequireAbility('read', 'Contract')
  async sprints(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(sprintQuery)) q: { projectId: string },
  ) {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.sprint.findMany({
      where: { projectId: q.projectId, project: { workspaceId } },
      orderBy: [{ position: 'asc' }, { startDate: 'asc' }],
      take: 200,
      select: { id: true, name: true, status: true },
    });
    return { items: rows };
  }

  @Get('tasks')
  @RequireAbility('read', 'Contract')
  async tasks(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(taskQuery)) q: { projectId: string; q?: string },
  ) {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.task.findMany({
      where: {
        projectId: q.projectId,
        project: { workspaceId },
        ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, title: true, status: true },
    });
    return { items: rows };
  }
}
