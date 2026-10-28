/**
 * Invoice status self-checks, no database: sending moves DRAFT to SENT as soon
 * as the email is queued (or the mailbox send is recorded), a queue failure is
 * a real error that leaves DRAFT alone, and manual status changes only allow
 * DRAFT / SENT / CANCELLED moves on unpaid invoices.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type InvoiceStatus } from '@botss/database';
import { setInvoiceStatusSchema, type InvoiceWithItems } from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import type { EmailService } from '../email/email.service';
import type { FilesService } from '../files/files.service';
import type { PaymentsService } from '../finance/payments.service';
import type { InvoiceRenderService } from '../invoices/invoice-render.service';
import type { InvoiceTemplatesService } from '../invoices/invoice-templates.service';
import { InvoicesService } from '../invoices/invoices.service';
import type { GotenbergClient } from '../pdf/gotenberg.client';
import type { PrismaService } from '../prisma/prisma.service';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

async function rejects(p: Promise<unknown>, type: new (...a: never[]) => Error): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof type;
  }
}

interface Row {
  id: string;
  workspaceId: string;
  number: string;
  status: InvoiceStatus;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  currency: string;
  dueAt: Date | null;
  pdfFileId: string | null;
}

type Where = {
  id: string;
  status?: InvoiceStatus | { in: InvoiceStatus[] };
  amountPaid?: { lte: number };
};

function matches(row: Row, where: Where): boolean {
  if (where.id !== row.id) return false;
  if (typeof where.status === 'string' && where.status !== row.status) return false;
  if (where.status && typeof where.status === 'object' && !where.status.in.includes(row.status))
    return false;
  if (where.amountPaid && !row.amountPaid.lte(where.amountPaid.lte)) return false;
  return true;
}

function setup(
  status: InvoiceStatus,
  paid = '0',
  queueResult: 'queued' | 'not-configured' | 'queue-failed' = 'queued',
) {
  const row: Row = {
    id: 'inv1',
    workspaceId: 'ws1',
    number: 'INV-2026-0001',
    status,
    total: new Prisma.Decimal('100'),
    amountPaid: new Prisma.Decimal(paid),
    currency: 'USD',
    dueAt: new Date('2026-10-15T00:00:00Z'),
    pdfFileId: null,
  };
  const prisma = {
    client: {
      invoice: {
        findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
          where.id === row.id && where.workspaceId === row.workspaceId
            ? { ...row, lineItems: [], payments: [] }
            : null,
        updateMany: async ({ where, data }: { where: Where; data: { status: InvoiceStatus } }) => {
          if (!matches(row, where)) return { count: 0 };
          row.status = data.status;
          return { count: 1 };
        },
      },
    },
  } as unknown as PrismaService;
  const email = { sendInvoice: async () => queueResult } as unknown as EmailService;
  const renderer = {
    settingsFor: async () => ({ organizationId: 'org1', settings: {} }),
  } as unknown as InvoiceRenderService;
  const svc = new InvoicesService(
    prisma,
    {} as PaymentsService,
    {} as InvoiceTemplatesService,
    renderer,
    {} as GotenbergClient,
    {} as FilesService,
    email,
  );
  // Rendering and the response shape are covered elsewhere; these checks are
  // about the status column.
  svc.ensurePdf = async () => ({
    fileId: 'f1',
    url: 'https://x/f1',
    filename: 'INV-2026-0001.pdf',
  });
  svc.get = async () => ({ ...row }) as unknown as InvoiceWithItems;
  return { svc, row };
}

const scope = { currentWorkspaceId: 'ws1', workspaceIds: ['ws1'] } as unknown as UserScope;
const systemSend = { via: 'system' as const, to: ['a@b.co'], subject: 'Invoice' };

async function main(): Promise<void> {
  // Send: system path marks SENT once queued.
  {
    const { svc, row } = setup('DRAFT');
    await svc.send(scope, 'inv1', systemSend);
    check('system send marks SENT when queued', row.status === 'SENT', row.status);
  }
  {
    const { svc, row } = setup('DRAFT', '0', 'queue-failed');
    check(
      'queue failure is a 503',
      await rejects(svc.send(scope, 'inv1', systemSend), ServiceUnavailableException),
    );
    check('queue failure leaves DRAFT', row.status === 'DRAFT', row.status);
  }
  {
    const { svc, row } = setup('DRAFT', '0', 'not-configured');
    check(
      'missing transport is a 400',
      await rejects(svc.send(scope, 'inv1', systemSend), BadRequestException),
    );
    check('missing transport leaves DRAFT', row.status === 'DRAFT', row.status);
  }
  {
    const { svc, row } = setup('DRAFT');
    await svc.send(scope, 'inv1', { via: 'mailbox' });
    check('mailbox send marks SENT', row.status === 'SENT', row.status);
  }
  {
    const { svc, row } = setup('PARTIALLY_PAID', '40');
    await svc.send(scope, 'inv1', systemSend);
    check('re-send keeps PARTIALLY_PAID', row.status === 'PARTIALLY_PAID', row.status);
  }

  // Manual status changes.
  const allowed: Array<[InvoiceStatus, 'DRAFT' | 'SENT' | 'CANCELLED']> = [
    ['DRAFT', 'SENT'],
    ['SENT', 'DRAFT'],
    ['OVERDUE', 'DRAFT'],
    ['DRAFT', 'CANCELLED'],
    ['SENT', 'CANCELLED'],
    ['OVERDUE', 'CANCELLED'],
  ];
  for (const [from, to] of allowed) {
    const { svc, row } = setup(from);
    await svc.setStatus(scope, 'inv1', { status: to });
    check(`${from} -> ${to}`, row.status === to, row.status);
  }

  const refused: Array<[InvoiceStatus, 'DRAFT' | 'SENT' | 'CANCELLED', string]> = [
    ['PAID', 'DRAFT', '100'],
    ['PARTIALLY_PAID', 'CANCELLED', '40'],
    ['CANCELLED', 'SENT', '0'],
    ['REFUNDED', 'DRAFT', '0'],
    ['SENT', 'DRAFT', '10'],
  ];
  for (const [from, to, paid] of refused) {
    const { svc, row } = setup(from, paid);
    check(
      `${from} (paid ${paid}) -> ${to} refused`,
      await rejects(svc.setStatus(scope, 'inv1', { status: to }), ConflictException),
    );
    check(`${from} unchanged after refusal`, row.status === from, row.status);
  }

  {
    const { svc, row } = setup('SENT');
    await svc.setStatus(scope, 'inv1', { status: 'SENT' });
    check('same status is a no-op', row.status === 'SENT', row.status);
  }

  check(
    'schema rejects PAID (paid states follow payments)',
    !setInvoiceStatusSchema.safeParse({ status: 'PAID' }).success,
  );
  check(
    'schema accepts CANCELLED',
    setInvoiceStatusSchema.safeParse({ status: 'CANCELLED' }).success,
  );

  if (failures > 0) {
    console.error(`invoice-status: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('invoice-status: all checks passed');
}

void main();
