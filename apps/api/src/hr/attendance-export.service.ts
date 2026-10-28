import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import type { Response } from 'express';

import { AdminUsersService } from '../admin/admin-users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';

@Injectable()
export class AttendanceExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminUsersService,
    @Optional() private readonly alerts?: SecurityAlertsService,
  ) {}

  /**
   * Stream a monthly timesheet for a single user as CSV. Employees may
   * only download their own; HR / Admin can target any user.
   *
   * Response is streamed row-by-row so a 2,000-row month doesn't have
   * to be buffered in memory. Caller is the controller - it owns the
   * response object and we just write into it.
   */
  async streamMonthlyTimesheet(
    actingUserId: string,
    targetUserId: string,
    monthSpec: string, // YYYY-MM, already validated by Zod
    res: Response,
  ): Promise<void> {
    if (targetUserId !== actingUserId) {
      await this.admin.assertAdminOrHR(actingUserId);
      // Same-org clamp: a tenant HR/Admin may only export users inside their
      // own organization. assertAdminOrHR is a role check with no tenant
      // boundary, so without this an Org A admin could stream any Org B
      // user's full timesheet via ?userId=<foreign user>.
      const [actor, target] = await Promise.all([
        this.prisma.client.user.findUnique({
          where: { id: actingUserId },
          select: { organizationId: true },
        }),
        this.prisma.client.user.findUnique({
          where: { id: targetUserId },
          select: { organizationId: true },
        }),
      ]);
      if (!target) {
        throw new ForbiddenException({ title: 'User not found', status: 404 });
      }
      if (!actor?.organizationId || actor.organizationId !== target.organizationId) {
        throw new ForbiddenException({
          title: 'Forbidden',
          status: 403,
          detail: 'You can only export timesheets for users in your own organization.',
        });
      }
    } else {
      const u = await this.prisma.client.user.findUnique({
        where: { id: actingUserId },
        select: { id: true },
      });
      if (!u) {
        throw new ForbiddenException({ title: 'User not found', status: 404 });
      }
    }
    const [yearStr, monthStr] = monthSpec.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr) - 1; // JS months are 0-indexed
    const from = new Date(Date.UTC(year, month, 1));
    const to = new Date(Date.UTC(year, month + 1, 1)); // exclusive

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="monthly_timesheet_${targetUserId}_${monthSpec}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');

    // Header row - order matches the spec exactly.
    res.write(
      [
        'Date',
        'Project Name',
        'Task Title',
        'Start Time',
        'End Time',
        'Paused Duration (Min)',
        'Net Duration (Hours)',
        'Billable Status',
        'Description',
      ]
        .map(csvCell)
        .join(',') + '\n',
    );

    const PAGE = 200;
    let cursor: string | null = null;
    let exported = 0;
    // Cursor-paginate so memory stays flat regardless of monthly volume.
    // We sort by startTime asc + id asc to keep the cursor stable.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows: Array<{
        id: string;
        startTime: Date;
        endTime: Date | null;
        durationMin: number | null;
        accumulatedPauseMin: number;
        billable: boolean;
        description: string | null;
        projectLabel: string | null;
        taskLabel: string | null;
        project: { name: string } | null;
        task: { title: string } | null;
      }> = await this.prisma.client.timeEntry.findMany({
        where: {
          userId: targetUserId,
          deletedAt: null,
          endTime: { not: null },
          startTime: { gte: from, lt: to },
        },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: PAGE,
        select: {
          id: true,
          startTime: true,
          endTime: true,
          durationMin: true,
          accumulatedPauseMin: true,
          billable: true,
          description: true,
          projectLabel: true,
          taskLabel: true,
          project: { select: { name: true } },
          task: { select: { title: true } },
        },
      });
      if (rows.length === 0) break;
      exported += rows.length;
      for (const r of rows) {
        const netHours = typeof r.durationMin === 'number' ? (r.durationMin / 60).toFixed(2) : '';
        res.write(
          [
            isoDate(r.startTime),
            r.project?.name ?? r.projectLabel ?? '',
            r.task?.title ?? r.taskLabel ?? '',
            isoTime(r.startTime),
            r.endTime ? isoTime(r.endTime) : '',
            String(r.accumulatedPauseMin),
            netHours,
            r.billable ? 'Billable' : 'Non-billable',
            r.description ?? '',
          ]
            .map(csvCell)
            .join(',') + '\n',
        );
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < PAGE) break;
    }

    void this.alerts?.recordExport(actingUserId, exported);
    res.end();
  }
}

/**
 * RFC 4180-ish CSV escaping. Wrap in double-quotes when the value
 * contains a comma, quote, or newline; double-up embedded quotes.
 *
 * Also neutralizes spreadsheet formula injection: user-controlled fields
 * (project/task names, descriptions) that begin with = + - @ (or tab/CR)
 * would otherwise execute as a formula when the CSV is opened in Excel or
 * Google Sheets. Prefix those with a single quote so they render as text.
 */
function csvCell(value: string): string {
  if (value === '' || value == null) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoTime(d: Date): string {
  const h = `${d.getUTCHours()}`.padStart(2, '0');
  const m = `${d.getUTCMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
}
