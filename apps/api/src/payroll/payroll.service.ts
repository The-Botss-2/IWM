import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  AddPayrollEmployeesInput,
  AddPayrollItemInput,
  CreatePayrollRunInput,
  PayPayrollRunInput,
  PayrollEmployee,
  PayrollEmployeeList,
  PayrollImportInput,
  PayrollImportPreview,
  PayrollImportResult,
  PayrollItem,
  PayrollRun,
  PayrollRunList,
  PayrollRunSummary,
  PayrollStaffList,
  SendPayslipsInput,
  SendPayslipsResult,
  UpdatePayrollEmployeeInput,
  UpdatePayrollItemInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { MAIL_SENDER } from '../email/email.service';
import { MailSendError, MailSender, renderPayslipEmail } from '../email/mail.sender';
import { bumpFinanceSummary } from '../finance/finance-summary-cache';
import { D, money, rate, requireWorkspace, round2, toDecimal } from '../finance/serialize';
import { GotenbergClient } from '../pdf/gotenberg.client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';
import { buildBankTransferCsv } from './payroll-csv';
import {
  type ImportPlan,
  type ImportValues,
  type LineExtras,
  planImport,
  resolveAmounts,
} from './payroll-import';
import {
  computeNet,
  expensesMatchLines,
  nameSlug,
  parseAmount,
  periodLabel,
  periodSlug,
  runTotals,
} from './payroll-math';
import {
  longPeriodLabel,
  PAYSLIP_MARGINS_MM,
  PAYSLIP_PAPER,
  PayslipRenderService,
  type PayslipSource,
  type PayslipViewModel,
} from './payslip-render.service';

const PAYROLL_CURRENCY = 'PKR';

type PayslipCompany = PayslipViewModel['company'];

const RUN_INCLUDE = {
  paymentSource: { select: { id: true, name: true } },
  items: {
    orderBy: { employeeName: 'asc' },
    // The person's current email: lines made before the email snapshot
    // existed have none of their own (see itemEmail).
    include: { employee: { select: { userId: true, email: true, user: { select: { email: true } } } } },
  },
} satisfies Prisma.PayrollRunInclude;

type RunRow = Prisma.PayrollRunGetPayload<{ include: typeof RUN_INCLUDE }>;
type ItemRow = RunRow['items'][number];

const EMPLOYEE_INCLUDE = {
  user: { select: { name: true, email: true, image: true } },
} satisfies Prisma.PayrollEmployeeInclude;

type EmployeeRow = Prisma.PayrollEmployeeGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>;

/** The month's run as the import sees it. */
type ImportRun = {
  id: string;
  status: 'DRAFT' | 'PAID';
  items: ({ employeeId: string | null } & LineExtras)[];
};

/**
 * The client inside `$transaction(async (tx) => ...)`. Inferred rather than
 * `Prisma.TransactionClient`, because the soft-delete extension makes it a
 * different type (same approach as InvoicesService.nextNumber).
 */
type TxClient = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];

/** Wrong mailbox passwords allowed per address before sending is paused. */
const MAIL_LOGIN_FAILURES = 3;
const MAIL_LOGIN_WINDOW_MS = 15 * 60_000;

/** Outgoing servers of the big providers, for addresses we have no settings for. */
const KNOWN_SMTP: Record<string, { host: string; port: number; secure: boolean }> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'googlemail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'live.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

/**
 * Payroll: who is on it (the roster), and one run per month.
 *
 * A run is built from the active roster and is editable while DRAFT. Paying
 * it records one SALARY expense per person in the same transaction, linked
 * through `PayrollItem.expenseId`; undoing it soft-deletes those expenses.
 * Those are the only writes payroll makes outside its own tables, and the
 * expenses service refuses to edit a payroll expense directly.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  /**
   * Recent wrong-password logins per workspace + mailbox. Every failed SMTP
   * login counts against the mail host's brute-force guard (cPHulk on our
   * cPanel host blocks the server's IP, which also stops mail sync), so
   * guessing is cut off well before that. In memory: a restart forgets it,
   * which is fine for a guard this coarse.
   */
  private readonly mailLoginFailures = new Map<string, number[]>();
  /**
   * Mailboxes sending right now. Parallel requests would each try the login
   * before any failure is counted, slipping past the guard above, and could
   * send the same payslips twice.
   */
  private readonly mailSending = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly payslips: PayslipRenderService,
    private readonly pdf: GotenbergClient,
    @Inject(MAIL_SENDER) private readonly mailer: MailSender,
    private readonly redis: RedisService,
    @Optional() private readonly alerts?: SecurityAlertsService,
  ) {}

  // ---------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------

  /** Every staff member of this workspace's organization, for the picker. */
  async listStaff(scope: UserScope): Promise<PayrollStaffList> {
    const workspaceId = requireWorkspace(scope);
    const organizationId = await this.organizationOf(workspaceId);
    const [users, roster] = await Promise.all([
      this.prisma.client.user.findMany({
        where: { organizationId, accountType: 'STAFF' },
        select: { id: true, name: true, email: true, image: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.client.payrollEmployee.findMany({
        where: { workspaceId },
        select: { id: true, userId: true },
      }),
    ]);
    const onRoster = new Map(
      roster.flatMap((r) => (r.userId ? [[r.userId, r.id] as const] : [])),
    );
    return {
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image ?? null,
        payrollEmployeeId: onRoster.get(u.id) ?? null,
      })),
    };
  }

  async listEmployees(scope: UserScope): Promise<PayrollEmployeeList> {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.payrollEmployee.findMany({
      where: { workspaceId },
      include: EMPLOYEE_INCLUDE,
    });
    // Sorted here: people without an account have no user to order by.
    const items = rows.map((r) => this.serializeEmployee(r));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items };
  }

  /**
   * Put people on payroll. Someone removed earlier is restored (the row is
   * soft-deleted, so the unique key still holds it) with the new salary.
   */
  async addEmployees(scope: UserScope, input: AddPayrollEmployeesInput): Promise<PayrollEmployeeList> {
    const workspaceId = requireWorkspace(scope);
    const organizationId = await this.organizationOf(workspaceId);
    const userIds = [...new Set(input.people.map((p) => p.userId))];
    const staff = await this.prisma.client.user.findMany({
      where: { id: { in: userIds }, organizationId, accountType: 'STAFF' },
      select: { id: true },
    });
    if (staff.length !== userIds.length) {
      throw new BadRequestException({
        title: 'Invalid people',
        status: 400,
        detail: 'Some of the selected people are not staff in this organization.',
        code: 'payroll_invalid_user',
      });
    }
    const people = input.people.map((p) => ({
      userId: p.userId,
      monthlySalary: parseAmount(p.monthlySalary, 'Monthly salary'),
      designation: clean(p.designation),
      bankName: clean(p.bankName),
      accountTitle: clean(p.accountTitle),
      accountNumber: clean(p.accountNumber),
    }));
    await this.prisma.client.$transaction(
      people.map((p) =>
        this.prisma.client.payrollEmployee.upsert({
          where: { workspaceId_userId: { workspaceId, userId: p.userId } },
          create: {
            workspaceId,
            userId: p.userId,
            monthlySalary: p.monthlySalary,
            currency: PAYROLL_CURRENCY,
            designation: p.designation ?? null,
            bankName: p.bankName ?? null,
            accountTitle: p.accountTitle ?? null,
            accountNumber: p.accountNumber ?? null,
            createdById: scope.userId,
          },
          update: {
            deletedAt: null,
            isActive: true,
            monthlySalary: p.monthlySalary,
            ...defined({
              designation: p.designation,
              bankName: p.bankName,
              accountTitle: p.accountTitle,
              accountNumber: p.accountNumber,
            }),
          },
        }),
      ),
    );
    return this.listEmployees(scope);
  }

  async updateEmployee(
    scope: UserScope,
    id: string,
    input: UpdatePayrollEmployeeInput,
  ): Promise<PayrollEmployee> {
    const workspaceId = requireWorkspace(scope);
    const current = await this.requireEmployee(workspaceId, id);
    const email = clean(input.email);
    const cnic = clean(input.cnic);
    const dateOfJoining = clean(input.dateOfJoining);
    const details = defined({
      // A platform user's name comes from their account.
      name: current.userId ? undefined : clean(input.name) ?? undefined,
      designation: clean(input.designation),
      bankName: clean(input.bankName),
      accountTitle: clean(input.accountTitle),
      accountNumber: clean(input.accountNumber),
      // The account email needs no copy; null means "use it".
      email:
        email === undefined
          ? undefined
          : email !== null && email.toLowerCase() === current.user?.email.toLowerCase()
            ? null
            : email?.toLowerCase() ?? null,
      cnic: cnic === undefined || cnic === null ? cnic : formatCnic(cnic),
      dateOfJoining:
        dateOfJoining === undefined || dateOfJoining === null ? dateOfJoining : dayFromIso(dateOfJoining),
      paymentMethod: input.paymentMethod,
    });
    const row = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.payrollEmployee.update({
        where: { id },
        data: {
          ...(input.monthlySalary !== undefined
            ? { monthlySalary: parseAmount(input.monthlySalary, 'Monthly salary') }
            : {}),
          ...details,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        include: EMPLOYEE_INCLUDE,
      });
      // Details added after a run was built must reach that run's CSV and
      // payslips while it is still a draft. Paid runs keep their snapshot.
      if (Object.keys(details).length > 0) {
        await this.refreshDraftLines(tx, workspaceId, updated);
      }
      return updated;
    });
    return this.serializeEmployee(row);
  }

  /** Copy a person's current details onto their lines in unpaid runs. */
  private async refreshDraftLines(
    tx: TxClient,
    workspaceId: string,
    employee: EmployeeRow,
    exceptRunId?: string,
  ): Promise<void> {
    await tx.payrollItem.updateMany({
      where: {
        employeeId: employee.id,
        ...(exceptRunId ? { runId: { not: exceptRunId } } : {}),
        run: { workspaceId, status: 'DRAFT', deletedAt: null },
      },
      data: snapshotOf(employee),
    });
  }

  /** Off payroll. Past runs keep their snapshot of this person. */
  async removeEmployee(scope: UserScope, id: string): Promise<void> {
    const workspaceId = requireWorkspace(scope);
    await this.requireEmployee(workspaceId, id);
    await this.prisma.client.payrollEmployee.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  async listRuns(scope: UserScope): Promise<PayrollRunList> {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.payrollRun.findMany({
      where: { workspaceId },
      include: RUN_INCLUDE,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return { items: rows.map((r) => this.serializeSummary(r)) };
  }

  async getRun(scope: UserScope, id: string): Promise<PayrollRun> {
    return this.serializeRun(await this.requireRun(requireWorkspace(scope), id));
  }

  /** A DRAFT run for the month, pre-filled from the active roster. */
  async createRun(scope: UserScope, input: CreatePayrollRunInput): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    // The bare client, so a soft-deleted run for the month is visible too.
    const existing = await this.prisma.raw.payrollRun.findFirst({
      where: { workspaceId, year: input.year, month: input.month },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({
        title: 'Payroll already exists',
        status: 409,
        detail: `There is already a payroll run for ${periodLabel(input.year, input.month)}.`,
        code: 'payroll_run_exists',
      });
    }
    // A run deleted earlier was a discarded draft (only drafts can be
    // deleted); clear it so the month's unique key is free again. The status
    // condition makes sure a paid run, and the expenses linked to it, can
    // never be wiped here.
    if (existing?.deletedAt) {
      await this.prisma.raw.payrollRun.deleteMany({
        where: { id: existing.id, status: 'DRAFT', deletedAt: { not: null } },
      });
    }

    const roster = await this.prisma.client.payrollEmployee.findMany({
      where: { workspaceId, isActive: true },
      include: EMPLOYEE_INCLUDE,
    });
    if (roster.length === 0) {
      throw new BadRequestException({
        title: 'Nobody on payroll',
        status: 400,
        detail: 'Add people to payroll before creating a run.',
        code: 'payroll_empty_roster',
      });
    }

    try {
      const run = await this.prisma.client.payrollRun.create({
        data: {
          workspaceId,
          year: input.year,
          month: input.month,
          createdById: scope.userId,
          items: {
            create: roster.map((e) => ({
              employeeId: e.id,
              ...snapshotOf(e),
              salary: e.monthlySalary,
              net: e.monthlySalary,
            })),
          },
        },
        include: RUN_INCLUDE,
      });
      return this.serializeRun(run);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          title: 'Payroll already exists',
          status: 409,
          detail: `There is already a payroll run for ${periodLabel(input.year, input.month)}.`,
          code: 'payroll_run_exists',
        });
      }
      throw err;
    }
  }

  /** Drafts only. Conditional, so it can never soft-delete a run being paid. */
  async deleteRun(scope: UserScope, id: string): Promise<void> {
    const workspaceId = requireWorkspace(scope);
    await this.requireRun(workspaceId, id);
    const deleted = await this.prisma.client.payrollRun.updateMany({
      where: { id, workspaceId, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count === 0) throw notDraft();
  }

  /** Add a roster person to a draft run (e.g. someone added after it was built). */
  async addItem(scope: UserScope, runId: string, input: AddPayrollItemInput): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    await this.requireRun(workspaceId, runId);
    const employee = await this.prisma.client.payrollEmployee.findFirst({
      where: { id: input.employeeId, workspaceId },
      include: EMPLOYEE_INCLUDE,
    });
    if (!employee) {
      throw new NotFoundException({ title: 'Not on payroll', status: 404 });
    }
    try {
      await this.inDraft(workspaceId, runId, (tx) =>
        tx.payrollItem.create({
          data: {
            runId,
            employeeId: employee.id,
            ...snapshotOf(employee),
            salary: employee.monthlySalary,
            net: employee.monthlySalary,
          },
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          title: 'Already in this run',
          status: 409,
          detail: `${displayName(employee)} is already in this payroll run.`,
          code: 'payroll_item_exists',
        });
      }
      throw err;
    }
    return this.getRun(scope, runId);
  }

  async updateItem(
    scope: UserScope,
    runId: string,
    itemId: string,
    input: UpdatePayrollItemInput,
  ): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    await this.requireRun(workspaceId, runId);
    await this.inDraft(workspaceId, runId, async (tx) => {
      // Read under the run lock, so two edits of the same line can't compute
      // net from each other's stale amounts.
      const item = await tx.payrollItem.findFirst({ where: { id: itemId, runId } });
      if (!item) throw new NotFoundException({ title: 'Payroll line not found', status: 404 });
      const amount = (value: string | number | undefined, label: string, saved: Prisma.Decimal) =>
        value !== undefined ? parseAmount(value, label) : new D(saved);
      const amounts = {
        salary: amount(input.salary, 'Salary', item.salary),
        bonus: amount(input.bonus, 'Bonus', item.bonus),
        commission: amount(input.commission, 'Commission', item.commission),
        deduction: amount(input.deduction, 'Deduction', item.deduction),
        tax: amount(input.tax, 'Tax', item.tax),
      };
      const net = computeNet(amounts);
      await tx.payrollItem.update({
        where: { id: itemId },
        data: {
          ...amounts,
          net,
          ...defined({ bonusNote: clean(input.bonusNote), deductionNote: clean(input.deductionNote) }),
        },
      });
    });
    return this.getRun(scope, runId);
  }

  async removeItem(scope: UserScope, runId: string, itemId: string): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    await this.requireRun(workspaceId, runId);
    await this.inDraft(workspaceId, runId, async (tx) => {
      const removed = await tx.payrollItem.deleteMany({ where: { id: itemId, runId } });
      if (removed.count === 0) {
        throw new NotFoundException({ title: 'Payroll line not found', status: 404 });
      }
    });
    return this.getRun(scope, runId);
  }

  /**
   * Run `fn` while holding the run's row lock and only if it is still a
   * draft. `pay` takes the same lock first (its conditional status flip), so
   * a line edit and a payment are strictly ordered: an edit can never land
   * after the salaries were booked from the old amounts.
   */
  private async inDraft<T>(
    workspaceId: string,
    runId: string,
    fn: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.payrollRun.updateMany({
        where: { id: runId, workspaceId, status: 'DRAFT', deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) throw notDraft();
      return fn(tx);
    });
  }

  /**
   * Mark the run paid and record one SALARY expense per person. The status
   * flip is a conditional update inside the transaction, so a double click
   * (or two people) can never pay the same run twice.
   */
  async pay(scope: UserScope, runId: string, input: PayPayrollRunInput): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    const run = await this.requireRun(workspaceId, runId);
    this.assertDraft(run);
    if (run.items.length === 0) {
      throw new BadRequestException({
        title: 'Nothing to pay',
        status: 400,
        detail: 'This payroll run has nobody in it.',
        code: 'payroll_run_empty',
      });
    }

    const { organizationId, baseCurrency } = await this.orgOf(workspaceId);
    const paymentSourceId = input.paymentSourceId ?? null;
    if (paymentSourceId) {
      const source = await this.prisma.client.paymentSource.findFirst({
        where: { id: paymentSourceId, organizationId },
        select: { id: true },
      });
      if (!source) {
        throw new BadRequestException({
          title: 'Invalid payment source',
          status: 400,
          detail: 'Payment source not found in this organization.',
          code: 'invalid_payment_source',
        });
      }
    }
    const fxRate = this.fxRateFor(baseCurrency, input.fxRate);
    const label = periodLabel(run.year, run.month);

    await this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.payrollRun.updateMany({
        where: { id: runId, workspaceId, status: 'DRAFT', deletedAt: null },
        data: { status: 'PAID', paidAt: input.paidAt, paymentSourceId, fxRate },
      });
      if (locked.count === 0) throw notDraft();

      const items = await tx.payrollItem.findMany({ where: { runId } });
      const payable = items.filter((item) => new D(item.net).gt(0));
      if (payable.length === 0) return;

      // One INSERT for every salary expense and one UPDATE linking them,
      // rather than two round trips per person.
      const expenses = await tx.expense.createManyAndReturn({
        data: payable.map((item) => {
          const net = new D(item.net);
          return {
            workspaceId,
            category: 'SALARY' as const,
            vendor: item.employeeName,
            description: `Salary ${label}`,
            amount: net,
            currency: PAYROLL_CURRENCY,
            fxRate,
            baseAmount: round2(net.times(fxRate)),
            paymentSourceId,
            incurredAt: input.paidAt,
            reference: `Payroll ${periodSlug(run.year, run.month)}`,
            recordedById: scope.userId,
          };
        }),
        select: { id: true, vendor: true, amount: true },
      });
      // INSERT ... RETURNING hands rows back in VALUES order, which is what
      // pairs each expense with its line. Checked rather than trusted: a
      // mismatch rolls the whole payment back instead of linking the wrong
      // person's salary.
      if (!expensesMatchLines(expenses, payable)) {
        throw new HttpException(
          {
            title: 'Payroll not paid',
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            detail: 'Salary expenses could not be matched to their payroll lines. Nothing was recorded; try again.',
            code: 'payroll_expense_link_failed',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      // Raw because every line gets a different expense id. `updatedAt` is
      // set by hand (Prisma's @updatedAt only fires on model writes), as UTC
      // wall time like every timestamp(3) column.
      const now = new Date().toISOString().slice(0, 23);
      await tx.$executeRaw`
        UPDATE "PayrollItem" AS p
        SET "expenseId" = v.eid, "updatedAt" = ${now}::timestamp(3)
        FROM (VALUES ${Prisma.join(payable.map((item, i) => Prisma.sql`(${item.id}, ${expenses[i]!.id})`))}) AS v(id, eid)
        WHERE p."id" = v.id AND p."runId" = ${runId}
      `;
    });
    await bumpFinanceSummary(this.redis, workspaceId);
    return this.getRun(scope, runId);
  }

  /** Back to DRAFT for corrections; the salary expenses are soft-deleted. */
  async unpay(scope: UserScope, runId: string): Promise<PayrollRun> {
    const workspaceId = requireWorkspace(scope);
    await this.requireRun(workspaceId, runId);
    await this.prisma.client.$transaction(async (tx) => {
      const reopened = await tx.payrollRun.updateMany({
        where: { id: runId, workspaceId, status: 'PAID', deletedAt: null },
        data: { status: 'DRAFT', paidAt: null, paymentSourceId: null, fxRate: new D(1) },
      });
      if (reopened.count === 0) {
        throw new ConflictException({
          title: 'Not paid',
          status: 409,
          detail: 'This payroll run is not marked as paid.',
          code: 'payroll_run_not_paid',
        });
      }
      const linked = await tx.payrollItem.findMany({
        where: { runId, expenseId: { not: null } },
        select: { expenseId: true },
      });
      const expenseIds = linked.map((l) => l.expenseId).filter((id): id is string => !!id);
      await tx.payrollItem.updateMany({ where: { runId }, data: { expenseId: null } });
      if (expenseIds.length > 0) {
        await tx.expense.updateMany({
          where: { id: { in: expenseIds }, workspaceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
    });
    await bumpFinanceSummary(this.redis, workspaceId);
    return this.getRun(scope, runId);
  }

  // ---------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------

  async payslipPdf(
    scope: UserScope,
    runId: string,
    itemId: string,
  ): Promise<{ body: Buffer; filename: string }> {
    const workspaceId = requireWorkspace(scope);
    const run = await this.requireRun(workspaceId, runId);
    const item = this.requireItem(run, itemId);
    const body = await this.renderPdf(workspaceId, run, [item]);
    return {
      body,
      filename: `payslip-${nameSlug(item.employeeName)}-${periodSlug(run.year, run.month)}.pdf`,
    };
  }

  async allPayslipsPdf(scope: UserScope, runId: string): Promise<{ body: Buffer; filename: string }> {
    const workspaceId = requireWorkspace(scope);
    const run = await this.requireRun(workspaceId, runId);
    if (run.items.length === 0) {
      throw new BadRequestException({
        title: 'No payslips',
        status: 400,
        detail: 'This payroll run has nobody in it.',
        code: 'payroll_run_empty',
      });
    }
    const body = await this.renderPdf(workspaceId, run, run.items);
    return { body, filename: `payslips-${periodSlug(run.year, run.month)}.pdf` };
  }

  async bankTransferCsv(scope: UserScope, runId: string): Promise<{ body: string; filename: string }> {
    const run = await this.requireRun(requireWorkspace(scope), runId);
    const bankItems = run.items.filter((i) => i.paymentMethod === 'BANK_TRANSFER');
    void this.alerts?.recordExport(scope.userId, bankItems.length);
    const body = buildBankTransferCsv(
      // Cash and cheque salaries are not bank transfers.
      bankItems.map((i) => ({
        employeeName: i.employeeName,
        accountTitle: i.accountTitle,
        bankName: i.bankName,
        accountNumber: i.accountNumber,
        net: money(i.net),
      })),
      `Salary ${periodLabel(run.year, run.month)}`,
    );
    return { body, filename: `bank-transfer-${periodSlug(run.year, run.month)}.csv` };
  }

  /**
   * `brand` lets a batch (emailing payslips) resolve the branding, its
   * inlined logo and the organization once and reuse them per document.
   */
  private async renderPdf(
    workspaceId: string,
    run: RunRow,
    items: ItemRow[],
    brand?: { company: PayslipCompany; organizationId: string },
  ): Promise<Buffer> {
    const sources: PayslipSource[] = items.map((i) => ({
      employeeName: i.employeeName,
      designation: i.designation,
      bankName: i.bankName,
      accountNumber: i.accountNumber,
      cnic: i.cnic,
      dateOfJoining: i.dateOfJoining,
      paymentMethod: i.paymentMethod,
      salary: money(i.salary),
      bonus: money(i.bonus),
      commission: money(i.commission),
      deduction: money(i.deduction),
      tax: money(i.tax),
      net: money(i.net),
      bonusNote: i.bonusNote,
      deductionNote: i.deductionNote,
    }));
    const models = await this.payslips.viewModels(workspaceId, run, sources, brand?.company);
    const html = await this.payslips.renderDocument(
      models,
      brand?.organizationId ?? (await this.organizationOf(workspaceId)),
    );
    return this.pdf.htmlToPdf(html, { paper: PAYSLIP_PAPER, marginsMm: PAYSLIP_MARGINS_MM });
  }

  // ---------------------------------------------------------------------
  // Import from a sheet
  // ---------------------------------------------------------------------

  /** What an import would do, row by row. Writes nothing. */
  async previewImport(scope: UserScope, input: PayrollImportInput): Promise<PayrollImportPreview> {
    const { plan, run } = await this.planFor(requireWorkspace(scope), input);
    const claimed = new Set(
      plan.rows.flatMap((r) => (r.target?.match === 'ON_PAYROLL' ? [r.target.employeeId] : [])),
    );
    return {
      year: plan.year,
      month: plan.month,
      run: run ? { id: run.id, status: run.status } : null,
      rows: plan.rows.map((r) => ({
        row: r.row,
        name: r.name,
        match: r.match,
        matchedBy: r.matchedBy,
        inRun: r.inRun,
        net: r.values ? money(r.values.net) : null,
        errors: r.errors,
      })),
      errors: plan.errors,
      notInSheet: run ? run.items.filter((i) => !i.employeeId || !claimed.has(i.employeeId)).length : 0,
    };
  }

  /**
   * Apply a sheet to the month's run, creating the run when there is none.
   * People on payroll get the sheet's details (blank cells keep what was
   * saved); platform staff are added to payroll; anyone else is added as a
   * payroll-only person. Each row sets that person's line for the month.
   * Refused while any row has an error, so a sheet lands whole or not at all.
   */
  async commitImport(scope: UserScope, input: PayrollImportInput): Promise<PayrollImportResult> {
    const workspaceId = requireWorkspace(scope);
    const { plan, run } = await this.planFor(workspaceId, input);
    const badRows = plan.rows.filter((r) => r.errors.length > 0).length;
    if (plan.errors.length > 0 || badRows > 0 || plan.year === null || plan.month === null) {
      throw new BadRequestException({
        title: 'Fix the sheet first',
        status: 400,
        detail:
          plan.errors[0] ??
          (badRows === 1 ? '1 row has an error.' : `${badRows} rows have errors.`),
        code: 'payroll_import_invalid',
      });
    }
    const year = plan.year;
    const month = plan.month;

    if (!run) {
      // Same as createRun: a discarded draft still holds the month's key.
      await this.prisma.raw.payrollRun.deleteMany({
        where: { workspaceId, year, month, status: 'DRAFT', deletedAt: { not: null } },
      });
    }

    const counts = { added: 0, updated: 0, newPeople: 0 };
    let runId: string;
    try {
      runId = await this.prisma.client.$transaction(
        async (tx) => {
          const id =
            run?.id ??
            (
              await tx.payrollRun.create({
                data: { workspaceId, year, month, createdById: scope.userId },
                select: { id: true },
              })
            ).id;
          // The run lock, as in inDraft: paying waits for the import.
          const locked = await tx.payrollRun.updateMany({
            where: { id, workspaceId, status: 'DRAFT', deletedAt: null },
            data: { updatedAt: new Date() },
          });
          if (locked.count === 0) throw notDraft();

          // Read under the lock: blank amount cells keep these.
          const lines = await tx.payrollItem.findMany({
            where: { runId: id },
            select: { id: true, employeeId: true, bonus: true, commission: true, deduction: true, tax: true },
          });
          const lineOf = new Map(lines.flatMap((l) => (l.employeeId ? [[l.employeeId, l] as const] : [])));

          // The per-row reads, fetched up front in two queries. Nothing the
          // loop writes changes what they feed (an employee's userId and the
          // account email), and a row whose record is not found here falls
          // back to the original findUniqueOrThrow, so a missing or
          // soft-deleted record behaves - and fails - exactly as before.
          const onPayrollIds = [
            ...new Set(plan.rows.flatMap((r) => (r.target?.match === 'ON_PAYROLL' ? [r.target.employeeId] : []))),
          ];
          const platformUserIds = [
            ...new Set(plan.rows.flatMap((r) => (r.target?.match === 'PLATFORM_USER' ? [r.target.userId] : []))),
          ];
          const currentOf = new Map(
            (onPayrollIds.length
              ? await tx.payrollEmployee.findMany({
                  where: { id: { in: onPayrollIds } },
                  include: EMPLOYEE_INCLUDE,
                })
              : []
            ).map((e) => [e.id, e]),
          );
          const emailOf = new Map(
            (platformUserIds.length
              ? await tx.user.findMany({
                  where: { id: { in: platformUserIds } },
                  select: { id: true, email: true },
                })
              : []
            ).map((u) => [u.id, u.email]),
          );

          // New lines are inserted together. A later row for the same person
          // (the planner rejects that, but just in case) flushes first so it
          // updates the stored line exactly as it did one write at a time.
          const pendingLines = new Map<string, Prisma.PayrollItemCreateManyInput>();
          const flushLines = async () => {
            if (pendingLines.size === 0) return;
            await tx.payrollItem.createMany({ data: [...pendingLines.values()] });
            const created = await tx.payrollItem.findMany({
              where: { runId: id, employeeId: { in: [...pendingLines.keys()] } },
              select: { id: true, employeeId: true, bonus: true, commission: true, deduction: true, tax: true },
            });
            for (const l of created) if (l.employeeId) lineOf.set(l.employeeId, l);
            pendingLines.clear();
          };

          for (const row of plan.rows) {
            const values = row.values!;
            const target = row.target!;
            let employee: EmployeeRow;
            if (target.match === 'ON_PAYROLL') {
              const current =
                currentOf.get(target.employeeId) ??
                (await tx.payrollEmployee.findUniqueOrThrow({
                  where: { id: target.employeeId },
                  include: EMPLOYEE_INCLUDE,
                }));
              employee = await tx.payrollEmployee.update({
                where: { id: target.employeeId },
                data: personData(values, current.user?.email ?? null, !current.userId),
                include: EMPLOYEE_INCLUDE,
              });
              await this.refreshDraftLines(tx, workspaceId, employee, id);
            } else if (target.match === 'PLATFORM_USER') {
              const email =
                emailOf.get(target.userId) ??
                (
                  await tx.user.findUniqueOrThrow({
                    where: { id: target.userId },
                    select: { email: true },
                  })
                ).email;
              const data = personData(values, email, false);
              employee = await tx.payrollEmployee.upsert({
                where: { workspaceId_userId: { workspaceId, userId: target.userId } },
                create: {
                  workspaceId,
                  userId: target.userId,
                  monthlySalary: values.salary,
                  currency: PAYROLL_CURRENCY,
                  createdById: scope.userId,
                  ...data,
                },
                update: { deletedAt: null, isActive: true, monthlySalary: values.salary, ...data },
                include: EMPLOYEE_INCLUDE,
              });
              counts.newPeople += 1;
            } else {
              employee = await tx.payrollEmployee.create({
                data: {
                  workspaceId,
                  userId: null,
                  monthlySalary: values.salary,
                  currency: PAYROLL_CURRENCY,
                  createdById: scope.userId,
                  ...personData(values, null, true),
                },
                include: EMPLOYEE_INCLUDE,
              });
              counts.newPeople += 1;
            }

            if (pendingLines.has(employee.id)) await flushLines();
            const existing = lineOf.get(employee.id);
            const amounts = resolveAmounts(values, existing);
            const line = { ...snapshotOf(employee), ...amounts, net: computeNet(amounts) };
            if (existing) {
              await tx.payrollItem.update({ where: { id: existing.id }, data: line });
              counts.updated += 1;
            } else {
              pendingLines.set(employee.id, { runId: id, employeeId: employee.id, ...line });
              counts.added += 1;
            }
          }
          await flushLines();
          return id;
        },
        // Up to 500 rows of several writes each.
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          title: 'Payroll changed',
          status: 409,
          detail: `Someone else just changed payroll for ${periodLabel(year, month)}. Import the sheet again.`,
          code: 'payroll_import_conflict',
        });
      }
      throw err;
    }
    // Only a committed import counts; a refused or rolled-back one does not.
    void this.alerts?.recordImport(scope.userId, plan.rows.length);
    return { run: await this.getRun(scope, runId), ...counts };
  }

  /** Load what matching needs, resolve the month, and plan every row. */
  private async planFor(
    workspaceId: string,
    input: PayrollImportInput,
  ): Promise<{ plan: ImportPlan; run: ImportRun | null }> {
    const organizationId = await this.organizationOf(workspaceId);
    const [rosterRows, staff] = await Promise.all([
      this.prisma.client.payrollEmployee.findMany({ where: { workspaceId }, include: EMPLOYEE_INCLUDE }),
      this.prisma.client.user.findMany({
        where: { organizationId, accountType: 'STAFF' },
        select: { id: true, name: true, email: true },
      }),
    ]);
    const roster = rosterRows.map((e) => ({
      id: e.id,
      userId: e.userId,
      name: displayName(e),
      email: payslipEmail(e),
      cnic: e.cnic,
    }));
    const given =
      input.year !== undefined && input.month !== undefined
        ? { year: input.year, month: input.month }
        : null;
    const plan = (target: { year: number; month: number } | null, run: ImportRun | null) =>
      planImport({
        rows: input.rows,
        target,
        roster,
        staff,
        inRun: new Map(run?.items.flatMap((i) => (i.employeeId ? [[i.employeeId, i] as const] : [])) ?? []),
        runStatus: run?.status ?? null,
      });

    // The month may come from the sheet itself, so the run is looked up
    // after a first pass has found it.
    const first = plan(given, null);
    if (first.year === null || first.month === null) return { plan: first, run: null };
    const run = await this.prisma.client.payrollRun.findFirst({
      where: { workspaceId, year: first.year, month: first.month },
      select: {
        id: true,
        status: true,
        items: { select: { employeeId: true, bonus: true, commission: true, deduction: true, tax: true } },
      },
    });
    return { plan: plan({ year: first.year, month: first.month }, run), run };
  }

  // ---------------------------------------------------------------------
  // Email payslips
  // ---------------------------------------------------------------------

  /**
   * Email each person their payslip PDF from the mailbox whose login was
   * typed in. The password lives only in this call: it is never stored,
   * logged or queued. One login covers the batch; a wrong password fails
   * before anything is sent. A person without an email is skipped, and one
   * failed message does not stop the rest. The browser sends a large run in
   * batches through `itemIds`, which keeps every request short.
   */
  async sendPayslips(scope: UserScope, runId: string, input: SendPayslipsInput): Promise<SendPayslipsResult> {
    const workspaceId = requireWorkspace(scope);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status !== 'PAID') {
      throw new ConflictException({
        title: 'Not paid yet',
        status: 409,
        detail: 'Mark this payroll run as paid before emailing payslips.',
        code: 'payroll_run_not_paid',
      });
    }
    let items = run.items;
    if (input.itemIds) {
      const wanted = new Set(input.itemIds);
      items = items.filter((i) => wanted.has(i.id));
      if (items.length !== wanted.size) {
        throw new NotFoundException({ title: 'Payroll line not found', status: 404 });
      }
    }

    const from = input.email.toLowerCase();
    const lockKey = `${workspaceId}:${from}`;
    this.assertMailLoginAllowed(lockKey, from);
    if (this.mailSending.has(lockKey)) {
      throw new ConflictException({
        title: 'Already sending',
        status: 409,
        detail: `Payslips are already being sent from ${from}. Wait for that to finish.`,
        code: 'payroll_mail_busy',
      });
    }
    this.mailSending.add(lockKey);
    try {
      return await this.sendFrom(workspaceId, run, items, from, lockKey, input);
    } finally {
      this.mailSending.delete(lockKey);
    }
  }

  private async sendFrom(
    workspaceId: string,
    run: RunRow,
    items: ItemRow[],
    from: string,
    lockKey: string,
    input: SendPayslipsInput,
  ): Promise<SendPayslipsResult> {
    const organizationId = await this.organizationOf(workspaceId);
    const smtp = await this.smtpFor(organizationId, from, input);
    // Resolved once for the whole batch: every payslip below reuses this
    // branding (and its inlined logo) instead of re-reading it per person.
    const company = await this.payslips.company(workspaceId);
    const brand = { company, organizationId };
    const period = longPeriodLabel(run.year, run.month);

    const results: SendPayslipsResult['results'] = [];
    try {
      await this.mailer.withSession(
        { ...smtp, user: from, pass: input.password },
        async (send) => {
          for (const item of items) {
            const to = itemEmail(item);
            const base = { itemId: item.id, name: item.employeeName, to };
            if (!to) {
              results.push({ ...base, status: 'SKIPPED', error: 'No email address' });
              continue;
            }
            try {
              const pdf = await this.renderPdf(workspaceId, run, [item], brand);
              const mail = renderPayslipEmail({
                companyName: company.name,
                employeeName: item.employeeName,
                period,
              });
              await send({
                from: { name: company.name, address: from },
                to,
                subject: mail.subject,
                html: mail.html,
                text: mail.text,
                attachments: [
                  {
                    filename: `payslip-${nameSlug(item.employeeName)}-${periodSlug(run.year, run.month)}.pdf`,
                    content: pdf,
                    contentType: 'application/pdf',
                  },
                ],
              });
            } catch (err) {
              // A login rejected mid-batch (a host starting to block us) ends
              // the batch: each further message would be another failed login.
              if (isAuthFailure(err)) throw err;
              results.push({ ...base, status: 'FAILED', error: sendFailure(err) });
              continue;
            }
            results.push({ ...base, status: 'SENT', error: null });
            // The mail is out; failing to record it must not report it as failed.
            await this.prisma.client.payrollItem
              .update({ where: { id: item.id }, data: { payslipSentAt: new Date(), payslipSentTo: to } })
              .catch((err: unknown) =>
                this.logger.warn(`Payslip ${item.id} sent but not recorded: ${(err as Error).message}`),
              );
          }
        },
      );
    } catch (err) {
      throw this.mailLoginError(err, lockKey, from, smtp);
    }
    this.mailLoginFailures.delete(lockKey);
    return {
      results,
      sent: results.filter((r) => r.status === 'SENT').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      skipped: results.filter((r) => r.status === 'SKIPPED').length,
    };
  }

  /**
   * The outgoing server for a mailbox: typed in, else a mail account already
   * connected for that address (or its domain) in this organization, else the
   * organization's mail settings for that domain, else a big provider's.
   */
  private async smtpFor(
    organizationId: string,
    email: string,
    input: SendPayslipsInput,
  ): Promise<{ host: string; port: number; secure: boolean }> {
    const withOverrides = (found: { host: string; port: number; secure: boolean }) => {
      const port = input.smtpPort ?? found.port;
      const secure = input.smtpSecure ?? (input.smtpPort ? port === 465 : found.secure);
      return { host: found.host, port, secure };
    };
    if (input.smtpHost) {
      // STARTTLS without a port means 587; implicit TLS means 465.
      const secure = input.smtpSecure !== false;
      return withOverrides({ host: input.smtpHost.trim(), port: secure ? 465 : 587, secure });
    }
    const domain = email.split('@')[1] ?? '';
    const accountSelect = { smtpHost: true, smtpPort: true, smtpSecure: true } as const;
    const inOrg = { deletedAt: null, workspace: { organizationId } };
    const account =
      (await this.prisma.client.mailAccount.findFirst({
        where: { ...inOrg, email: { equals: email, mode: 'insensitive' } },
        select: accountSelect,
      })) ??
      (await this.prisma.client.mailAccount.findFirst({
        where: { ...inOrg, email: { endsWith: `@${domain}`, mode: 'insensitive' } },
        select: accountSelect,
      }));
    if (account) {
      return withOverrides({ host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure });
    }
    const org = await this.prisma.client.organizationMailConfig.findUnique({
      where: { organizationId },
      select: { smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, fromEmail: true },
    });
    const sameDomain = (value: string) => value.toLowerCase().endsWith(`@${domain}`);
    if (org && (sameDomain(org.smtpUser) || sameDomain(org.fromEmail))) {
      return withOverrides({ host: org.smtpHost, port: org.smtpPort, secure: org.smtpSecure });
    }
    const known = KNOWN_SMTP[domain];
    if (known) return withOverrides(known);
    throw new BadRequestException({
      title: 'Mail server needed',
      status: 400,
      detail: `Enter the outgoing mail server (SMTP) for ${domain}.`,
      code: 'payroll_smtp_host_required',
    });
  }

  private assertMailLoginAllowed(key: string, email: string): void {
    const now = Date.now();
    const recent = (this.mailLoginFailures.get(key) ?? []).filter((t) => now - t < MAIL_LOGIN_WINDOW_MS);
    if (recent.length === 0) this.mailLoginFailures.delete(key);
    else this.mailLoginFailures.set(key, recent);
    if (recent.length >= MAIL_LOGIN_FAILURES) {
      const minutes = Math.ceil((MAIL_LOGIN_WINDOW_MS - (now - recent[0]!)) / 60_000);
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Too many wrong passwords',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: `The password for ${email} was wrong ${MAIL_LOGIN_FAILURES} times. Try again in ${minutes} min, so the mail server does not block us.`,
          code: 'payroll_mail_locked',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** The login or connection failed before any payslip was sent. */
  private mailLoginError(
    err: unknown,
    lockKey: string,
    email: string,
    smtp: { host: string; port: number },
  ): HttpException {
    if (err instanceof HttpException) return err;
    if (isAuthFailure(err)) {
      this.mailLoginFailures.set(lockKey, [...(this.mailLoginFailures.get(lockKey) ?? []), Date.now()]);
      return new BadRequestException({
        title: 'Login failed',
        status: 400,
        detail: `The mail server rejected the password for ${email}. Gmail and Outlook need an app password.`,
        code: 'payroll_mail_auth',
      });
    }
    this.logger.warn(`Payslip mail connect to ${smtp.host}:${smtp.port} failed: ${(err as Error)?.message}`);
    return new BadRequestException({
      title: "Couldn't connect",
      status: 400,
      detail: `Couldn't connect to the mail server ${smtp.host}:${smtp.port}. Check the server and port.`,
      code: 'payroll_mail_connect',
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async organizationOf(workspaceId: string): Promise<string> {
    return (await this.orgOf(workspaceId)).organizationId;
  }

  private async orgOf(workspaceId: string): Promise<{ organizationId: string; baseCurrency: string }> {
    const ws = await this.prisma.client.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true, organization: { select: { baseCurrency: true } } },
    });
    return { organizationId: ws.organizationId, baseCurrency: ws.organization?.baseCurrency ?? 'PKR' };
  }

  /**
   * PKR to the organization's base currency. Forced to 1 when the base is
   * PKR (a rate between a currency and itself is nonsense), and required
   * otherwise, so reports never sum PKR as if it were the base currency.
   */
  private fxRateFor(baseCurrency: string, input: string | number | undefined): Prisma.Decimal {
    if (baseCurrency === PAYROLL_CURRENCY) return new D(1);
    const parsed = input === undefined || input === '' ? null : toDecimal(input, 0);
    // Rounded to the column's 8dp BEFORE it is used, so baseAmount is
    // computed from exactly the rate that gets stored; bounded to what
    // Decimal(18, 8) can hold.
    const fx = parsed ? new D(parsed.toFixed(8, D.ROUND_HALF_UP)) : null;
    if (!fx || fx.lte(0) || fx.gt('9999999999.99999999')) {
      throw new BadRequestException({
        title: 'Exchange rate required',
        status: 400,
        detail: `Enter the PKR to ${baseCurrency} exchange rate for this payroll.`,
        code: 'invalid_fx_rate',
      });
    }
    return fx;
  }

  private async requireEmployee(workspaceId: string, id: string): Promise<EmployeeRow> {
    const row = await this.prisma.client.payrollEmployee.findFirst({
      where: { id, workspaceId },
      include: EMPLOYEE_INCLUDE,
    });
    if (!row) throw new NotFoundException({ title: 'Not on payroll', status: 404 });
    return row;
  }

  private async requireRun(workspaceId: string, id: string): Promise<RunRow> {
    const run = await this.prisma.client.payrollRun.findFirst({
      where: { id, workspaceId },
      include: RUN_INCLUDE,
    });
    if (!run) throw new NotFoundException({ title: 'Payroll run not found', status: 404 });
    return run;
  }

  private requireItem(run: RunRow, itemId: string): ItemRow {
    const item = run.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException({ title: 'Payroll line not found', status: 404 });
    return item;
  }

  private assertDraft(run: { status: string }): void {
    if (run.status !== 'DRAFT') throw notDraft();
  }

  private serializeEmployee(r: EmployeeRow): PayrollEmployee {
    return {
      id: r.id,
      userId: r.userId,
      name: displayName(r),
      email: payslipEmail(r),
      image: r.user?.image ?? null,
      cnic: r.cnic,
      dateOfJoining: isoDay(r.dateOfJoining),
      paymentMethod: r.paymentMethod,
      monthlySalary: money(r.monthlySalary),
      currency: r.currency,
      designation: r.designation,
      bankName: r.bankName,
      accountTitle: r.accountTitle,
      accountNumber: r.accountNumber,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private serializeItem(i: ItemRow): PayrollItem {
    return {
      id: i.id,
      employeeId: i.employeeId,
      userId: i.employee?.userId ?? null,
      employeeName: i.employeeName,
      designation: i.designation,
      bankName: i.bankName,
      accountTitle: i.accountTitle,
      accountNumber: i.accountNumber,
      cnic: i.cnic,
      dateOfJoining: isoDay(i.dateOfJoining),
      paymentMethod: i.paymentMethod,
      email: itemEmail(i),
      salary: money(i.salary),
      bonus: money(i.bonus),
      commission: money(i.commission),
      deduction: money(i.deduction),
      tax: money(i.tax),
      net: money(i.net),
      bonusNote: i.bonusNote,
      deductionNote: i.deductionNote,
      expenseId: i.expenseId,
      payslipSentAt: i.payslipSentAt,
      payslipSentTo: i.payslipSentTo,
    };
  }

  private serializeSummary(r: RunRow): PayrollRunSummary {
    return {
      id: r.id,
      year: r.year,
      month: r.month,
      status: r.status,
      paidAt: r.paidAt,
      paymentSource: r.paymentSource ?? null,
      fxRate: rate(r.fxRate),
      currency: PAYROLL_CURRENCY,
      people: r.items.length,
      ...runTotals(r.items),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private serializeRun(r: RunRow): PayrollRun {
    return { ...this.serializeSummary(r), items: r.items.map((i) => this.serializeItem(i)) };
  }
}

function notDraft(): ConflictException {
  return new ConflictException({
    title: 'Payroll already paid',
    status: 409,
    detail: 'Undo the payment to change this payroll run.',
    code: 'payroll_run_not_draft',
  });
}

/** Trim; an empty string means "clear the field". `undefined` stays untouched. */
function clean(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Drop keys whose value is `undefined`, so an update leaves them alone. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The roster details a payroll line keeps, frozen at the time it was added. */
function snapshotOf(e: EmployeeRow) {
  return {
    employeeName: displayName(e),
    designation: e.designation,
    bankName: e.bankName,
    accountTitle: e.accountTitle,
    accountNumber: e.accountNumber,
    cnic: e.cnic,
    dateOfJoining: e.dateOfJoining,
    paymentMethod: e.paymentMethod,
    email: payslipEmail(e),
  };
}

/** The account's name, or the payroll-only name for someone without one. */
function displayName(e: EmployeeRow): string {
  return e.user?.name ?? e.name ?? '';
}

/** The payslip email: the payroll one if set, else the account's. */
function payslipEmail(e: EmployeeRow): string | null {
  return e.email ?? e.user?.email ?? null;
}

/** A `@db.Date` value as "YYYY-MM-DD" (stored as UTC midnight). */
function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function dayFromIso(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** "35202-1234567-1" from 13 digits with or without dashes (already validated). */
function formatCnic(value: string): string {
  const d = value.replace(/\D/g, '');
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

/**
 * Roster fields from a sheet row. Blank cells (undefined) leave the saved
 * value alone; a new person gets null for them through the column default.
 * `accountEmail` is the platform account's email: a matching sheet email
 * needs no copy. `ownName` is true for someone without an account.
 */
function personData(values: ImportValues, accountEmail: string | null, ownName: boolean) {
  return defined({
    name: ownName ? values.name : undefined,
    designation: values.designation,
    dateOfJoining: values.dateOfJoining,
    cnic: values.cnic,
    paymentMethod: values.paymentMethod,
    email:
      values.email === undefined
        ? undefined
        : accountEmail && values.email === accountEmail.toLowerCase()
          ? null
          : values.email,
    bankName: values.bankName,
    accountTitle: values.accountTitle,
    accountNumber: values.accountNumber,
  });
}

/** Where this payslip goes: the line's snapshot, else the person's current email. */
function itemEmail(i: ItemRow): string | null {
  return i.email ?? i.employee?.email ?? i.employee?.user?.email ?? null;
}

function isAuthFailure(err: unknown): boolean {
  return (
    err instanceof MailSendError &&
    (err.code === 'EAUTH' || err.responseCode === 534 || err.responseCode === 535)
  );
}

/** A per-person send failure, short enough for the results list. */
function sendFailure(err: unknown): string {
  if (err instanceof MailSendError) {
    return err.responseCode ? `Rejected by the mail server (${err.responseCode})` : "Couldn't send";
  }
  return "Couldn't generate the payslip";
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
