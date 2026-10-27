import { Injectable } from '@nestjs/common';
import { Prisma } from '@botss/database';
import type { CalendarEvent, CalendarEventType } from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectVisibilityWhere } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async listEvents(
    scope: UserScope,
    from: Date,
    to: Date,
    types: CalendarEventType[],
  ): Promise<{ items: CalendarEvent[] }> {
    const wantTasks = types.length === 0 || types.includes('task');
    const wantTodos = types.length === 0 || types.includes('todo');
    const wantTime = types.length === 0 || types.includes('time');

    const events: CalendarEvent[] = [];

    if (wantTasks) {
      const projectOr: Prisma.TaskWhereInput[] = [];
      if (scope.workspaceIds.length > 0) {
        projectOr.push({ project: { workspaceId: { in: scope.workspaceIds } } });
      }
      if (scope.projectIds.length > 0) {
        projectOr.push({ projectId: { in: scope.projectIds } });
      }
      if (projectOr.length > 0) {
        // PRIVATE projects must not surface their tasks on the calendar of a
        // non-member - the calendar is one of the easiest places for a hidden
        // project to leak, since it aggregates across every project at once.
        const visibility = projectVisibilityWhere(scope);
        const tasks = await this.prisma.client.task.findMany({
          where: {
            deletedAt: null,
            ...(visibility
              ? { project: visibility as Prisma.ProjectWhereInput }
              : {}),
            OR: [
              {
                AND: [
                  { OR: projectOr },
                  {
                    OR: [
                      { dueDate: { gte: from, lte: to } },
                      { startDate: { gte: from, lte: to } },
                    ],
                  },
                ],
              },
            ],
          },
          include: {
            project: { select: { id: true, name: true, color: true } },
          },
          take: 1000,
        });
        for (const t of tasks) {
          const start = t.startDate ?? t.dueDate;
          if (!start) continue;
          events.push({
            id: `task:${t.id}`,
            type: 'task',
            title: t.title,
            start,
            end: t.dueDate ?? null,
            color: t.project?.color ?? null,
            projectId: t.project?.id ?? null,
            projectName: t.project?.name ?? null,
            meta: {
              taskId: t.id,
              status: t.status,
              priority: t.priority,
              assigneeId: t.assigneeId,
            },
          });
        }
      }
    }

    if (wantTodos && scope.currentWorkspaceId) {
      const todos = await this.prisma.client.todo.findMany({
        where: {
          userId: scope.userId,
          workspaceId: scope.currentWorkspaceId,
          deletedAt: null,
          dueDate: { gte: from, lte: to },
        },
        take: 500,
      });
      for (const t of todos) {
        if (!t.dueDate) continue;
        events.push({
          id: `todo:${t.id}`,
          type: 'todo',
          title: t.title,
          start: t.dueDate,
          end: null,
          color: null,
          projectId: null,
          projectName: null,
          meta: {
            todoId: t.id,
            priority: t.priority,
            done: t.done,
          },
        });
      }
    }

    if (wantTime && scope.currentWorkspaceId) {
      const entries = await this.prisma.client.timeEntry.findMany({
        where: {
          userId: scope.userId,
          workspaceId: scope.currentWorkspaceId,
          deletedAt: null,
          startTime: { gte: from, lte: to },
        },
        include: { project: { select: { id: true, name: true, color: true } } },
        take: 500,
      });
      for (const e of entries) {
        events.push({
          id: `time:${e.id}`,
          type: 'time',
          title: e.description ?? e.project?.name ?? 'Tracked time',
          start: e.startTime,
          end: e.endTime,
          color: e.project?.color ?? null,
          projectId: e.projectId,
          projectName: e.project?.name ?? null,
          meta: {
            timeEntryId: e.id,
            durationMin: e.durationMin,
            billable: e.billable,
          },
        });
      }
    }

    events.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { items: events };
  }
}
