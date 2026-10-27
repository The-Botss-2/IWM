import { Injectable, NotFoundException } from '@nestjs/common';
import {
  portalProjectDetailSchema,
  portalProjectListSchema,
  type PortalProgress,
  type PortalProjectDetail,
  type PortalProjectList,
  type PortalProjectSummary,
} from '@botss/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import {
  portalMilestoneContractWhere,
  portalProjectWhere,
  portalTaskWhere,
  toPortalProgress,
} from './portal-rules';
import { PortalScopeService, type PortalContact } from './portal-scope';

const PROJECT_SELECT = {
  id: true,
  name: true,
  status: true,
  color: true,
  startDate: true,
  dueDate: true,
} as const;

/** Most tasks a portal project page lists at once. */
const TASK_LIMIT = 500;

@Injectable()
export class PortalProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PortalScopeService,
  ) {}

  async list(userId: string, clientId: string): Promise<PortalProjectList> {
    const contact = await this.scope.require(userId, clientId);
    return portalProjectListSchema.parse({ items: await this.summaries(contact) });
  }

  /** Also used by the overview, which already holds the contact. */
  async summaries(contact: PortalContact): Promise<PortalProjectSummary[]> {
    const projects = await this.prisma.client.project.findMany({
      where: portalProjectWhere(contact),
      select: PROJECT_SELECT,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { name: 'asc' }],
    });
    const progress = await this.progressFor(projects.map((p) => p.id));
    return projects.map((p) => ({ ...p, progress: progress.get(p.id) ?? toPortalProgress([]) }));
  }

  async detail(userId: string, clientId: string, projectId: string): Promise<PortalProjectDetail> {
    const contact = await this.scope.require(userId, clientId);
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...portalProjectWhere(contact) },
      select: { ...PROJECT_SELECT, portalShowAllTasks: true },
    });
    if (!project) {
      throw new NotFoundException({ title: 'Project not found', status: 404 });
    }
    const seesMoney = contact.role === 'PRIMARY';
    const [progress, contracts, tasks] = await Promise.all([
      this.progressFor([project.id]),
      this.prisma.client.contract.findMany({
        where: portalMilestoneContractWhere(contact, project.id),
        select: {
          currency: true,
          milestones: {
            where: { status: { not: 'CANCELLED' } },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              title: true,
              status: true,
              dueDate: true,
              deliveredAt: true,
              amount: true,
              paymentStatus: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.client.task.findMany({
        where: portalTaskWhere(project.id, project.portalShowAllTasks),
        select: {
          id: true,
          title: true,
          status: true,
          startDate: true,
          dueDate: true,
          completedAt: true,
        },
        orderBy: [{ status: 'asc' }, { position: 'asc' }],
        take: TASK_LIMIT,
      }),
    ]);

    const milestones = contracts.flatMap((c) =>
      c.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        dueDate: m.dueDate,
        deliveredAt: m.deliveredAt,
        // Money is billing: main contact only.
        amount: seesMoney ? m.amount.toFixed(2) : null,
        currency: seesMoney ? c.currency : null,
        paymentStatus: seesMoney ? m.paymentStatus : null,
      })),
    );

    const { portalShowAllTasks, ...summary } = project;
    return portalProjectDetailSchema.parse({
      ...summary,
      progress: progress.get(project.id) ?? toPortalProgress([]),
      milestones,
      taskMode: portalShowAllTasks ? 'ALL' : 'MARKED',
      tasks,
    });
  }

  /** One grouped query for every project, not one per project. */
  private async progressFor(projectIds: string[]): Promise<Map<string, PortalProgress>> {
    if (projectIds.length === 0) return new Map();
    const rows = await this.prisma.client.task.groupBy({
      by: ['projectId', 'status'],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    });
    const byProject = new Map<string, { status: string; count: number }[]>();
    for (const row of rows) {
      const list = byProject.get(row.projectId) ?? [];
      list.push({ status: row.status, count: row._count._all });
      byProject.set(row.projectId, list);
    }
    return new Map(projectIds.map((id) => [id, toPortalProgress(byProject.get(id) ?? [])]));
  }
}
