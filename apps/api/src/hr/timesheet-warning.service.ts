import { Injectable, Logger } from '@nestjs/common';

import { ChatGateway } from '../chat/chat.gateway';
import { ChatService } from '../chat/chat.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Detects employees who stop posting timesheets and alerts HR.
 *
 * Configured by two env vars; the pass does nothing unless both are set:
 *   - `HR_EMAIL_DOMAIN`: the organization to scan, matched on its
 *     `emailDomain`; only users whose email ends with this domain are
 *     scanned or notified.
 *   - `HR_SENDER_EMAIL`: the existing user the warnings are sent from.
 *
 * Who is SCANNED: only `EMPLOYEE`-role users in that organization whose email
 * ends with the domain AND who are not `timesheetExempt`. HR / admins are never scanned
 * (hard-excluded), and any individual flagged "not obligated to submit
 * timesheets" via `User.timesheetExempt` is skipped.
 *
 * Who is NOTIFIED: the org's `HR`-role users AND the delinquent employee
 * themselves. HR receives a per-employee warning (with the employee's name)
 * for each delinquent plus a single roll-up summary per run. Each delinquent
 * (non-exempt) employee is also DMed a direct warning from the HR bot.
 * Admins / super-admins are NOT notified.
 *
 * "Missed a working day" reuses the attendance materialisation the daily
 * cron already produces: a day is counted only when `Attendance.status =
 * ABSENT`, which the cron writes for a *weekday* with no approved leave, no
 * holiday, and no TimeEntry. Weekends carry no row, so they're skipped (not
 * a break) - a Fri/Mon/Tue gap is a streak of 3.
 *
 * Cadence: a warning fires when the consecutive-missed-working-day count
 * reaches a multiple of {@link THRESHOLD_DAYS} (3, 6, 9, ...), so HR is
 * re-nudged about a persistently delinquent employee every three missed
 * days without daily spam. Stateless - the multiple-of-three test only
 * matches once per level.
 */
@Injectable()
export class TimesheetWarningService {
  private readonly logger = new Logger(TimesheetWarningService.name);

  /** Consecutive missed working days that trips (and re-trips) a warning. */
  private static readonly THRESHOLD_DAYS = 3;
  /** How far back to pull attendance when measuring a streak. */
  private static readonly LOOKBACK_DAYS = 45;
  /** The scanned organization's email domain + the HR sender identity, from env. */
  private static config(): { domain: string; senderEmail: string } | null {
    const domain = process.env.HR_EMAIL_DOMAIN?.trim().toLowerCase();
    const senderEmail = process.env.HR_SENDER_EMAIL?.trim().toLowerCase();
    return domain && senderEmail ? { domain, senderEmail } : null;
  }
  /**
   * Roles that get a personal timesheet warning. Currently employees only;
   * widen this later if PMs (or others) should be nudged too.
   */
  private static readonly WARNED_ROLES = ['EMPLOYEE'] as const;
  /**
   * Roles that are NEVER scanned, regardless of {@link WARNED_ROLES}. Admins,
   * HR, and super-admins are never themselves flagged for a missing timesheet.
   * (HR additionally are the *recipients* of the warnings; admins and
   * super-admins are not notified at all.) Kept as a separate hard exclusion
   * so broadening WARNED_ROLES can't accidentally start scanning one of them.
   */
  private static readonly EXEMPT_ROLES = ['ADMIN', 'HR', 'SUPER_ADMIN'] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly gateway: ChatGateway,
  ) {}

  /**
   * Scan every in-scope employee and DM a warning to those whose missed
   * working-day streak (ending yesterday) is a non-zero multiple of the
   * threshold. Safe to re-run: a second run on the same day re-evaluates
   * the same streaks, so guard the schedule to once daily.
   */
  async warnDelinquentEmployees(referenceDate?: Date): Promise<{
    scanned: number;
    warned: number;
    employeesWarned: number;
    supervisorsNotified: number;
  }> {
    const config = TimesheetWarningService.config();
    if (!config) {
      this.logger.debug('HR_EMAIL_DOMAIN / HR_SENDER_EMAIL not set; skipping timesheet warnings.');
      return { scanned: 0, warned: 0, employeesWarned: 0, supervisorsNotified: 0 };
    }
    const { domain, senderEmail } = config;

    const org = await this.prisma.client.organization.findUnique({
      where: { emailDomain: domain },
      select: { id: true },
    });
    if (!org) {
      this.logger.warn(
        `No organization found for emailDomain=${domain}; skipping timesheet warnings.`,
      );
      return { scanned: 0, warned: 0, employeesWarned: 0, supervisorsNotified: 0 };
    }

    const hrSender = await this.prisma.client.user.findFirst({
      where: {
        email: senderEmail,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!hrSender) {
      this.logger.warn(
        `No active user with email=${senderEmail}; cannot send timesheet warnings.`,
      );
      return { scanned: 0, warned: 0, employeesWarned: 0, supervisorsNotified: 0 };
    }

    const employees = await this.prisma.client.user.findMany({
      where: {
        organizationId: org.id,
        deletedAt: null,
        email: { endsWith: `@${domain}` },
        // Skip anyone explicitly not obligated to submit timesheets.
        timesheetExempt: false,
        // Scan only the opted-in roles, and hard-exclude the exempt ones
        // (admins / HR / super-admins) so they're never scanned even if
        // WARNED_ROLES is widened later.
        AND: [
          { systemRole: { in: [...TimesheetWarningService.WARNED_ROLES] } },
          { systemRole: { notIn: [...TimesheetWarningService.EXEMPT_ROLES] } },
        ],
      },
      select: { id: true, name: true, email: true },
    });
    if (employees.length === 0) {
      return { scanned: 0, warned: 0, employeesWarned: 0, supervisorsNotified: 0 };
    }

    // Resolve the HR-role users who now receive the warnings (instead of the
    // delinquent employees). Exclude the HR sender so it never DMs itself.
    const hrRecipients = await this.prisma.client.user.findMany({
      where: {
        organizationId: org.id,
        systemRole: 'HR',
        deletedAt: null,
        email: { endsWith: `@${domain}` },
        id: { not: hrSender.id },
      },
      select: { id: true },
    });
    if (hrRecipients.length === 0) {
      this.logger.warn(
        'No HR-role users to notify; timesheet warnings have no recipient this run.',
      );
    }

    // Yesterday (UTC midnight) is the last day the attendance cron has
    // materialised; the streak we care about ends there.
    const yesterday = startOfDay(referenceDate ?? new Date());
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const windowStart = new Date(yesterday);
    windowStart.setUTCDate(
      windowStart.getUTCDate() - TimesheetWarningService.LOOKBACK_DAYS,
    );

    const employeeIds = employees.map((e) => e.id);
    const rows = await this.prisma.client.attendance.findMany({
      where: {
        userId: { in: employeeIds },
        date: { gte: windowStart, lte: yesterday },
      },
      select: { userId: true, date: true, status: true },
    });
    // userId -> (isoDate -> status)
    const byUser = new Map<string, Map<string, string>>();
    for (const r of rows) {
      let m = byUser.get(r.userId);
      if (!m) {
        m = new Map();
        byUser.set(r.userId, m);
      }
      m.set(toISODate(r.date), r.status);
    }

    // Employees whose streak is a non-zero multiple of the threshold this
    // run. Posting a timesheet on (or before) the trigger day flips that
    // day to PRESENT, which breaks the streak - so a late submission on
    // the third day quietly resets and no warning is sent.
    const delinquents: { name: string | null; streak: number }[] = [];
    let warned = 0;
    let employeesWarned = 0;
    for (const emp of employees) {
      const streak = this.missedStreak(byUser.get(emp.id), yesterday);
      const trips =
        streak >= TimesheetWarningService.THRESHOLD_DAYS &&
        streak % TimesheetWarningService.THRESHOLD_DAYS === 0;
      if (!trips) continue;
      delinquents.push({ name: emp.name, streak });
      // Warn HR about this employee.
      const hrText = buildHrAlertText(emp.name, emp.email, streak);
      for (const hr of hrRecipients) {
        try {
          await this.sendDm(hrSender.id, hr.id, hrText);
        } catch (err) {
          this.logger.error(
            `Failed to send timesheet warning to HR userId=${hr.id} about employee=${emp.id} streak=${streak} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        }
      }
      if (hrRecipients.length > 0) warned++;

      // Warn the (non-exempt) employee directly, as a DM from the HR bot.
      try {
        await this.sendDm(
          hrSender.id,
          emp.id,
          buildEmployeeWarningText(emp.name, streak),
        );
        employeesWarned++;
      } catch (err) {
        this.logger.error(
          `Failed to send timesheet warning to employee userId=${emp.id} streak=${streak} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    const supervisorsNotified =
      delinquents.length > 0
        ? await this.notifyHrSummary(org.id, domain, hrSender.id, delinquents)
        : 0;

    this.logger.log(
      `Timesheet warnings scanned=${employees.length} warned=${warned} employeesWarned=${employeesWarned} supervisorsNotified=${supervisorsNotified}`,
    );
    return {
      scanned: employees.length,
      warned,
      employeesWarned,
      supervisorsNotified,
    };
  }

  /**
   * DM the org's HR-role users a single roll-up of the employees flagged
   * this run. Admins / super-admins are deliberately NOT notified - timesheet
   * follow-up is HR's responsibility. The HR sender and anyone outside the
   * configured domain are excluded.
   */
  private async notifyHrSummary(
    orgId: string,
    domain: string,
    hrSenderId: string,
    delinquents: { name: string | null; streak: number }[],
  ): Promise<number> {
    const supervisors = await this.prisma.client.user.findMany({
      where: {
        organizationId: orgId,
        systemRole: 'HR',
        deletedAt: null,
        email: { endsWith: `@${domain}` },
        id: { not: hrSenderId },
      },
      select: { id: true },
    });
    const text = buildSupervisorSummaryText(delinquents);
    let notified = 0;
    for (const sup of supervisors) {
      try {
        await this.sendDm(hrSenderId, sup.id, text);
        notified++;
      } catch (err) {
        this.logger.error(
          `Failed to send timesheet summary to supervisor userId=${sup.id} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    return notified;
  }

  /**
   * Count consecutive missed working days ending at `lastDay`, walking
   * backwards. Weekends are skipped (no row, never a break). An `ABSENT`
   * row extends the streak; any other status (PRESENT / LEAVE / HOLIDAY)
   * or a missing weekday row ends it.
   */
  private missedStreak(
    statusByDay: Map<string, string> | undefined,
    lastDay: Date,
  ): number {
    if (!statusByDay) return 0;
    let streak = 0;
    const cursor = new Date(lastDay);
    for (let i = 0; i <= TimesheetWarningService.LOOKBACK_DAYS; i++) {
      const dow = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
      if (dow !== 0 && dow !== 6) {
        const status = statusByDay.get(toISODate(cursor));
        if (status === 'ABSENT') {
          streak++;
        } else {
          break;
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
  }

  /**
   * Find (or reuse) the HR -> recipient DM and post a message. The HR
   * user is the room creator, so it's a participant and `sendMessage`'s
   * membership check passes. A best-effort socket broadcast lets an
   * online recipient see it immediately; the persisted row + the
   * service's web-push fan-out cover the offline case.
   */
  private async sendDm(
    hrUserId: string,
    recipientId: string,
    content: string,
  ): Promise<void> {
    const room = await this.chat.createRoom(
      hrUserId,
      { type: 'DM', participantUserIds: [recipientId] },
      null,
    );
    const message = await this.chat.sendMessage(hrUserId, {
      roomId: room.id,
      content,
    });
    try {
      await this.gateway.broadcastNewMessage({
        roomId: room.id,
        senderUserId: hrUserId,
        message,
        clientNonce: null,
      });
    } catch (err) {
      this.logger.warn(
        `Timesheet warning broadcast failed roomId=${room.id} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }
}

function buildHrAlertText(
  employeeName: string | null,
  employeeEmail: string,
  streak: number,
): string {
  const who = employeeName?.trim() ? `${employeeName} (${employeeEmail})` : employeeEmail;
  return (
    `Automated timesheet alert. ` +
    `${who} has not posted a timesheet for ${streak} consecutive working days. ` +
    `Please follow up with them. ` +
    `If they were on approved leave, record it so this clears. ` +
    `- HR bot`
  );
}

function buildEmployeeWarningText(
  employeeName: string | null,
  streak: number,
): string {
  const greeting = employeeName?.trim() ? `Hi ${employeeName.trim()}, ` : 'Hi, ';
  return (
    `${greeting}this is an automated reminder from HR. ` +
    `Our records show no timesheet from you for ${streak} consecutive working days. ` +
    `Please log your time as soon as possible. ` +
    `If you were on approved leave, let HR know so this can be cleared. ` +
    `- HR bot`
  );
}

function buildSupervisorSummaryText(
  delinquents: { name: string | null; streak: number }[],
): string {
  const lines = delinquents
    .slice()
    .sort((a, b) => b.streak - a.streak)
    .map((d) => `- ${d.name ?? 'Unknown'} (${d.streak} working days)`)
    .join('\n');
  const count = delinquents.length;
  return (
    `Automated timesheet report. ` +
    `${count} employee${count === 1 ? ' has' : 's have'} not posted a timesheet ` +
    `for 3 or more consecutive working days:\n${lines}`
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function toISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}
