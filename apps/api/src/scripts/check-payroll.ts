/**
 * Payroll self-checks that need no database, Redis or Gotenberg:
 *
 * 1. Net pay math: salary + bonus + commission - deduction - tax, 2dp
 *    rounding, and refusal of negative or malformed amounts (a bad salary
 *    must never become 0).
 * 2. The bank-transfer CSV: header, zero-net rows skipped, quoting, and
 *    spreadsheet formula injection neutralized.
 * 3. The payslip template (the default salary slip layout) renders every
 *    figure as "PKR 25,000" without losing paisa, every row even when zero,
 *    bank lines only for a bank transfer, and the signatory stamp.
 * 4. Permissions: only Admin, Super Admin and Finance reach the Payroll
 *    subject; an employee or a workspace owner does not.
 * 5. The sheet import: cell parsing (CNIC, dates, months, payment methods,
 *    amounts) and matching rows to people on payroll, platform staff, or new
 *    people without an account.
 *
 * Run: pnpm --filter @botss/api test (chained after the mail governor check).
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { defineAbilityFor } from '@botss/auth';

import { TEMPLATE_HELPERS } from '../invoices/invoice-templates.service';
import { compileTemplate } from '../invoices/template-engine';
import { D } from '../finance/serialize';
import { accountCell, buildBankTransferCsv, csvCell } from '../payroll/payroll-csv';
import {
  computeNet,
  expensesMatchLines,
  maskAccount,
  nameSlug,
  parseAmount,
  periodLabel,
  periodSlug,
  runTotals,
} from '../payroll/payroll-math';
import {
  parseCnic,
  parseDateCell,
  parseMonthCell,
  parsePaymentMethod,
  planImport,
} from '../payroll/payroll-import';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import type { InvoiceRenderService } from '../invoices/invoice-render.service';
import { buildPayslipViewModel, payslipExtras, PayslipRenderService } from '../payroll/payslip-render.service';

function throwsCode(fn: () => unknown, code: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const res = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
    assert.equal(res?.code, code, `${label}: wrong error code`);
    return;
  }
  assert.fail(`${label}: expected ${code}`);
}

function mathChecks(): void {
  assert.equal(parseAmount('150000', 'Salary').toFixed(2), '150000.00');
  assert.equal(parseAmount('1,250.505', 'Salary').toFixed(2), '1250.51', 'commas stripped, half-up');
  assert.equal(parseAmount(99.994, 'Salary').toFixed(2), '99.99');
  assert.equal(parseAmount('', 'Bonus').toFixed(2), '0.00', 'empty means zero');
  throwsCode(() => parseAmount('abc', 'Salary'), 'payroll_invalid_amount', 'letters');
  throwsCode(() => parseAmount('-5', 'Salary'), 'payroll_invalid_amount', 'negative');
  throwsCode(() => parseAmount('1000000000000', 'Salary'), 'payroll_invalid_amount', 'too large');

  const line = (salary: string, bonus: string, commission: string, deduction: string, tax: string) => ({
    salary: new D(salary),
    bonus: new D(bonus),
    commission: new D(commission),
    deduction: new D(deduction),
    tax: new D(tax),
  });
  assert.equal(computeNet(line('100000', '5000.50', '0', '2500.25', '0')).toFixed(2), '102500.25');
  assert.equal(
    computeNet(line('100000', '5000', '12000.50', '2000', '7500.25')).toFixed(2),
    '107500.25',
    'commission adds, tax subtracts',
  );
  assert.equal(computeNet(line('100', '0', '0', '60', '40')).toFixed(2), '0.00', 'zero net allowed');
  throwsCode(() => computeNet(line('100', '0', '0', '100', '0.01')), 'payroll_negative_net', 'negative net');

  const totals = runTotals([
    { salary: '100000.00', bonus: '5000.00', commission: '2000.00', deduction: '0.00', tax: '1500.00', net: '105500.00' },
    {
      salary: new D('80000.10'),
      bonus: new D('0'),
      commission: new D('0'),
      deduction: new D('1000.05'),
      tax: new D('0'),
      net: new D('79000.05'),
    },
  ]);
  assert.deepEqual(totals, {
    totalSalary: '180000.10',
    totalBonus: '5000.00',
    totalCommission: '2000.00',
    totalDeduction: '1000.05',
    totalTax: '1500.00',
    totalNet: '184500.05',
  });

  assert.equal(periodLabel(2026, 9), 'Sep 2026');
  assert.equal(periodSlug(2026, 1), '2026-01');
  assert.equal(maskAccount('PK36 SCBL 0000 0011 2345 6702'), '•••• 6702');
  assert.equal(maskAccount('123'), '123');
  assert.equal(maskAccount(null), null);
  assert.equal(nameSlug('Ayesha Noor Khan'), 'ayesha-noor-khan');
  assert.equal(nameSlug('***'), 'employee');

  // Paying a run pairs batch-inserted expenses with lines by position.
  const lines = [
    { employeeName: 'Ali', net: new D('1000.00') },
    { employeeName: 'Sara', net: new D('2500.50') },
  ];
  assert.ok(expensesMatchLines([{ vendor: 'Ali', amount: '1000' }, { vendor: 'Sara', amount: new D('2500.5') }], lines));
  assert.ok(!expensesMatchLines([{ vendor: 'Sara', amount: '2500.50' }, { vendor: 'Ali', amount: '1000.00' }], lines), 'swapped order');
  assert.ok(!expensesMatchLines([{ vendor: 'Ali', amount: '1000.00' }], lines), 'missing row');
  assert.ok(!expensesMatchLines([{ vendor: 'Ali', amount: '1000.00' }, { vendor: 'Sara', amount: '2500.51' }], lines), 'amount differs');
  assert.ok(!expensesMatchLines([{ vendor: 'Ali', amount: '1000.00' }, { vendor: null, amount: '2500.50' }], lines), 'vendor lost');
  assert.ok(expensesMatchLines([], []), 'nothing to pay');
  console.log('payroll math ok');
}

function csvChecks(): void {
  const csv = buildBankTransferCsv(
    [
      { employeeName: 'Ayesha Khan', accountTitle: 'Ayesha Khan', bankName: 'Meezan', accountNumber: 'PK36MEZN0001', net: '150000.00' },
      { employeeName: 'Unpaid Person', accountTitle: null, bankName: null, accountNumber: null, net: '0.00' },
      { employeeName: '=HYPERLINK("http://evil")', accountTitle: 'Doe, John', bankName: '@SUM(A1)', accountNumber: '-123', net: '1.00' },
    ],
    'Salary Sep 2026',
  );
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Name,Account title,Bank,Account number / IBAN,Amount (PKR),Reference');
  assert.equal(lines[1], 'Ayesha Khan,Ayesha Khan,Meezan,PK36MEZN0001,150000.00,Salary Sep 2026');
  assert.ok(!csv.includes('Unpaid Person'), 'zero net skipped');
  assert.equal(
    lines[2],
    `"'=HYPERLINK(""http://evil"")","Doe, John",'@SUM(A1),'-123,1.00,Salary Sep 2026`,
  );
  assert.equal(lines.at(-1), '', 'ends with CRLF');
  assert.equal(csvCell('+1'), "'+1");
  // Digit-only account numbers stay text in Excel (leading zeros, 16 digits).
  assert.equal(accountCell('0123 4567 8901 2345'), '"=""0123456789012345"""');
  assert.equal(accountCell('PK36MEZN0001'), 'PK36MEZN0001');
  assert.equal(accountCell('=cmd'), "'=cmd");
  console.log('payroll csv ok');
}

async function payslipChecks(): Promise<void> {
  // The root organization's signatory comes from the environment; unset means none.
  delete process.env.PAYSLIP_SIGNATORY_NAME;
  delete process.env.PAYSLIP_SIGNATORY_TITLE;
  assert.equal(payslipExtras(ROOT_ORG_ID).signatory, null, 'no signatory when PAYSLIP_SIGNATORY_NAME is unset');
  process.env.PAYSLIP_SIGNATORY_NAME = 'Jane Doe';
  process.env.PAYSLIP_SIGNATORY_TITLE = 'CEO';
  const dir = path.resolve(__dirname, '..', '..', 'payslip-templates', 'default');
  const source = await fs.readFile(path.join(dir, 'template.html'), 'utf8');
  const template = compileTemplate(source, TEMPLATE_HELPERS);
  const company = {
    name: 'Example Co',
    logo: null,
    address: 'Lahore',
    email: 'billing@example.com',
    phone: null,
    website: null,
    taxId: null,
    bankDetails: null,
    paymentTerms: null,
    footer: null,
    accentColor: '#7b6fe8',
  };
  const vm = buildPayslipViewModel(
    company,
    { year: 2026, month: 9, paidAt: new Date('2026-09-30T00:00:00Z') },
    {
      employeeName: 'Ayesha <Khan>',
      designation: 'Engineer',
      bankName: 'Meezan',
      accountNumber: 'PK36MEZN0001234567',
      cnic: '35202-1234567-1',
      dateOfJoining: new Date('2024-03-01T00:00:00Z'),
      paymentMethod: 'BANK_TRANSFER',
      salary: '150000.00',
      bonus: '5000.00',
      commission: '12000.00',
      deduction: '1000.00',
      tax: '7500.00',
      net: '158500.00',
      bonusNote: 'Project delivery',
      deductionNote: 'Advance',
    },
    new Date('2026-09-30T00:00:00Z'),
  );
  const own = payslipExtras(ROOT_ORG_ID);
  const html = template.render({ ...vm, assets: { logo: true, stamp: true }, signatory: own.signatory });
  for (const expected of [
    'SALARY SLIP',
    'September 2026',
    'Ayesha &lt;Khan&gt;',
    'Engineer',
    'PKR 150,000<',
    'PKR 5,000<',
    'PKR 1,000<',
    'PKR 12,000<',
    'PKR 7,500<',
    'PKR 158,500<',
    'Project delivery',
    'Advance',
    // In full, as on the slips the team already issues.
    'PK36MEZN0001234567',
    'Meezan',
    '35202-1234567-1',
    'Bank transfer',
    'Jane Doe',
    'CEO',
    'asset-stamp',
    'asset-logo',
  ]) {
    assert.ok(html.includes(expected), `payslip shows ${expected}`);
  }
  assert.match(html, /1 Mar 2024/, 'payslip shows the date of joining');

  // Every row shows, as "PKR 0" when zero; a cash salary has no bank lines.
  const cash = template.render({
    ...vm,
    amounts: { ...vm.amounts, bonus: '0.00', commission: '0.00', deduction: '0.00', tax: '0.00', net: '150000.50', salary: '150000.50' },
    employee: { ...vm.employee, cnic: null, dateOfJoining: null, paymentMethod: 'Cash', isBankTransfer: false },
    bonusNote: null,
    deductionNote: null,
    assets: { logo: false, stamp: false },
    signatory: null,
  });
  for (const row of ['Bonus', 'Deduction', 'Commission', 'Tax']) {
    assert.ok(cash.includes(`<td>${row}`), `${row} row shown when zero`);
  }
  assert.ok(cash.includes('PKR 0<'), 'zero amounts read PKR 0');
  assert.ok(cash.includes('PKR 150,000.50<'), 'paisa are never rounded away');
  assert.ok(!cash.includes('PK36MEZN0001234567') && !cash.includes('Meezan'), 'no bank lines for a cash salary');
  assert.ok(cash.includes('Cash'), 'payment method shown');
  // Any other organization (anyone can sign up) never gets the operator's
  // signature, stamp or logo.
  const other = payslipExtras('org_someone_else');
  assert.equal(other.own, false);
  assert.equal(other.signatory, null, 'no signatory for another organization');
  assert.equal(own.own, true);
  assert.ok(!cash.includes('asset-stamp') && !cash.includes('Jane Doe'), 'no stamp or signatory without them');

  // The gate itself, through the real document renderer (it reads the
  // template folder's logo.png and stamp.png).
  const renderer = new PayslipRenderService({} as InvoiceRenderService);
  const ours = await renderer.renderDocument([vm], ROOT_ORG_ID);
  for (const expected of ['data:image/png;base64,', 'class="stamp asset-stamp"', 'Jane Doe']) {
    assert.ok(ours.includes(expected), `the root organization's payslip has ${expected}`);
  }
  const theirs = await renderer.renderDocument([vm], 'org_someone_else');
  for (const forbidden of ['data:image/png', 'class="stamp asset-stamp"', 'class="logo asset-logo"', 'Jane Doe']) {
    assert.ok(!theirs.includes(forbidden), `another organization's payslip has no ${forbidden}`);
  }

  // A batch hands its one branding lookup to every payslip: with `company`
  // supplied, no further lookup happens (the stub would throw), and the
  // models match the ones built from a fresh lookup.
  let lookups = 0;
  const counting = new PayslipRenderService({
    brandingFor: async () => {
      lookups += 1;
      return company;
    },
  } as unknown as InvoiceRenderService);
  const run = { year: 2026, month: 9, paidAt: new Date('2026-09-30T00:00:00Z') };
  const slip = { ...vm.amounts, ...vm.employee, employeeName: 'Ayesha <Khan>', paymentMethod: 'BANK_TRANSFER' as const, bonusNote: null, deductionNote: null };
  const fresh = await counting.viewModels('ws1', run, [slip]);
  assert.equal(lookups, 1, 'no company supplied: one lookup');
  const reused = await counting.viewModels('ws1', run, [slip], company);
  assert.equal(lookups, 1, 'company supplied: no lookup');
  const { generatedAt: _a, ...freshRest } = fresh[0]!;
  const { generatedAt: _b, ...reusedRest } = reused[0]!;
  assert.deepEqual(reusedRest, freshRest, 'same payslip either way');
  console.log('payslip template ok');
}

function permissionChecks(): void {
  const ws = 'ws1';
  const ability = (systemRole: 'EMPLOYEE' | 'FINANCE' | 'ADMIN' | 'SUPER_ADMIN' | 'HR', role: 'OWNER' | 'MEMBER') =>
    defineAbilityFor({
      userId: 'u1',
      systemRole,
      workspaceMemberships: [{ workspaceId: ws, role }],
      projectMemberships: [],
    });
  assert.ok(!ability('EMPLOYEE', 'MEMBER').can('read', 'Payroll'), 'employee cannot read payroll');
  assert.ok(!ability('EMPLOYEE', 'OWNER').can('read', 'Payroll'), 'workspace owner is not finance');
  assert.ok(!ability('HR', 'MEMBER').can('read', 'Payroll'), 'HR is not finance');
  for (const role of ['FINANCE', 'ADMIN', 'SUPER_ADMIN'] as const) {
    const a = ability(role, 'MEMBER');
    for (const action of ['read', 'create', 'update', 'delete'] as const) {
      assert.ok(a.can(action, 'Payroll'), `${role} can ${action} payroll`);
    }
  }
  console.log('payroll permissions ok');
}

function importChecks(): void {
  assert.equal(parseCnic('3520212345671'), '35202-1234567-1');
  assert.equal(parseCnic('35202-1234567-1'), '35202-1234567-1');
  assert.equal(parseCnic('35202 1234567 1'), '35202-1234567-1');
  assert.equal(parseCnic('3520212345'), null, 'too short');
  assert.equal(parseCnic('35202-1234567-X'), null, 'letters');

  const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
  assert.equal(day(parseDateCell('2024-03-01')), '2024-03-01');
  assert.equal(day(parseDateCell('01/03/2024')), '2024-03-01', 'day first');
  assert.equal(day(parseDateCell('1-3-24')), '2024-03-01');
  assert.equal(day(parseDateCell('1 Mar 2024')), '2024-03-01');
  assert.equal(day(parseDateCell('1-Mar-24')), '2024-03-01');
  assert.equal(day(parseDateCell('March 1, 2024')), '2024-03-01');
  assert.equal(parseDateCell('31/02/2024'), null, 'no 31 February');
  assert.equal(parseDateCell('soon'), null);

  assert.deepEqual(parseMonthCell('September 2026'), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthCell('Sept 2026'), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthCell('Sep-26'), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthCell('2026-09'), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthCell('09/2026'), { year: 2026, month: 9 });
  assert.deepEqual(parseMonthCell('2026-09-01'), { year: 2026, month: 9 }, 'Excel date cell');
  assert.deepEqual(parseMonthCell('30/09/2026'), { year: 2026, month: 9 });
  assert.equal(parseMonthCell('Septober 2026'), null);

  assert.equal(parsePaymentMethod('Bank Transfer'), 'BANK_TRANSFER');
  assert.equal(parsePaymentMethod('IBFT'), 'BANK_TRANSFER');
  assert.equal(parsePaymentMethod('cash'), 'CASH');
  assert.equal(parsePaymentMethod('Cheque'), 'CHEQUE');
  assert.equal(parsePaymentMethod('crypto'), null);

  const roster = [
    { id: 'e1', userId: 'u1', name: 'Ayesha Khan', email: 'ayesha@example.com', cnic: null },
    { id: 'e2', userId: null, name: 'Bilal Driver', email: null, cnic: '35202-1111111-1' },
    { id: 'e3', userId: 'u3', name: 'Sara Ali', email: 'sara.personal@gmail.com', cnic: null },
  ];
  const staff = [
    { id: 'u1', name: 'Ayesha Khan', email: 'ayesha@example.com' },
    { id: 'u2', name: 'Omar Farooq', email: 'omar@example.com' },
    { id: 'u3', name: 'Sara Ali', email: 'sara@example.com' },
  ];
  const row = (n: number, cells: Record<string, string>) => ({ row: n, basic: '100000', ...cells });
  const plan = planImport({
    rows: [
      row(2, { name: 'A. Khan', email: 'AYESHA@example.com', month: 'Sep 2026', tax: '5,000', commission: 'PKR 2,000' }),
      row(3, { cnic: '3520211111111', name: '', month: 'September 2026' }),
      row(4, { name: 'Omar Farooq', email: 'omar@example.com', doj: '01/03/2024', paymentMethod: 'Cash', month: '09/2026' }),
      row(5, { name: 'Zainab Cook', cnic: '35202-2222222-2' }),
      row(6, { name: 'Sara Ali', email: 'sara@example.com' }),
      row(7, { name: 'Ayesha Khan', email: 'ayesha@example.com' }),
      row(8, { name: 'Bad Row', basic: '', cnic: '123', paymentMethod: 'crypto', email: 'nope', month: 'Aug 2026' }),
      row(9, { name: 'Too Much', deduction: '90000', tax: '20000' }),
    ],
    target: null,
    roster,
    staff,
    // Ayesha's line this month already has a bonus and a deduction.
    inRun: new Map([['e1', { bonus: new D('1000'), commission: new D('0'), deduction: new D('500'), tax: new D('0') }]]),
    runStatus: 'DRAFT',
  });
  assert.equal(plan.year, 2026, 'month most rows name');
  assert.equal(plan.month, 9);
  assert.deepEqual(plan.errors, []);
  const [ayesha, bilal, omar, zainab, sara, dupe, bad, tooMuch] = plan.rows;
  assert.deepEqual(ayesha!.target, { match: 'ON_PAYROLL', employeeId: 'e1' }, 'email match, any case');
  assert.equal(ayesha!.matchedBy, 'email');
  assert.equal(ayesha!.inRun, true);
  assert.equal(
    ayesha!.values!.net.toFixed(2),
    '97500.00',
    'amount labels and commas read; blank bonus and deduction keep the saved line',
  );
  assert.equal(ayesha!.values!.bonus, undefined, 'blank bonus is left for the saved line');
  assert.deepEqual(bilal!.target, { match: 'ON_PAYROLL', employeeId: 'e2' }, 'CNIC match without a name');
  assert.equal(bilal!.name, 'Bilal Driver', 'name filled from payroll');
  assert.deepEqual(omar!.target, { match: 'PLATFORM_USER', userId: 'u2' }, 'staff added to payroll');
  assert.equal(omar!.values!.paymentMethod, 'CASH');
  assert.equal(omar!.values!.dateOfJoining!.toISOString().slice(0, 10), '2024-03-01');
  assert.deepEqual(zainab!.target, { match: 'NEW_PERSON' }, 'unknown person is new');
  assert.deepEqual(sara!.target, { match: 'ON_PAYROLL', employeeId: 'e3' }, 'account email finds the roster row');
  assert.ok(dupe!.errors.includes('Same person as row 2.'), 'duplicate person caught');
  assert.equal(bad!.values, null);
  for (const fragment of ['Basic salary is empty', 'CNIC must have 13 digits', 'Payment method', 'is not an email', 'Month is Aug 2026']) {
    assert.ok(bad!.errors.some((e) => e.includes(fragment)), `bad row reports: ${fragment}`);
  }
  assert.ok(tooMuch!.errors.some((e) => e.includes('larger than basic')), 'negative net refused');

  const mixed = planImport({
    rows: [row(2, { name: 'X', month: 'Sep 2026' }), row(3, { name: 'Y', month: 'Oct 2026' })],
    target: null,
    roster: [],
    staff: [],
    inRun: new Map(),
    runStatus: null,
  });
  assert.equal(mixed.month, null);
  assert.ok(mixed.errors[0]!.includes('more than one month'));
  const paid = planImport({
    rows: [row(2, { name: 'X' })],
    target: { year: 2026, month: 9 },
    roster: [],
    staff: [],
    inRun: new Map(),
    runStatus: 'PAID',
  });
  assert.ok(paid.errors[0]!.includes('already paid'), 'a paid run is refused');
  const twins = planImport({
    rows: [row(2, { name: 'Muhammad Ali' }), row(3, { name: 'Muhammad Ali', cnic: '35202-3333333-3' })],
    target: { year: 2026, month: 9 },
    roster: [
      { id: 'm1', userId: null, name: 'Muhammad Ali', email: null, cnic: '35202-3333333-3' },
      { id: 'm2', userId: null, name: 'Muhammad  ali', email: null, cnic: null },
    ],
    staff: [],
    inRun: new Map(),
    runStatus: null,
  });
  assert.equal(twins.rows[0]!.target, null, 'an ambiguous name is never guessed');
  assert.ok(twins.rows[0]!.errors[0]!.includes('More than one person'));
  assert.deepEqual(twins.rows[1]!.target, { match: 'ON_PAYROLL', employeeId: 'm1' }, 'CNIC settles it');
  // A second staff member with an existing payroll person's name.
  const namesake = planImport({
    rows: [
      row(2, { name: 'Ayesha Khan', email: 'ayesha.k@example.com' }),
      row(3, { name: 'Ayesha Khan' }),
      row(4, { name: 'Bilal Driver', cnic: '35202-9999999-9' }),
    ],
    target: { year: 2026, month: 9 },
    roster,
    staff: [...staff, { id: 'u4', name: 'Ayesha Khan', email: 'ayesha.k@example.com' }],
    inRun: new Map(),
    runStatus: null,
  });
  assert.deepEqual(
    namesake.rows[0]!.target,
    { match: 'PLATFORM_USER', userId: 'u4' },
    'a staff email beats a name match',
  );
  assert.ok(namesake.rows[1]!.errors[0]!.includes('More than one person'), 'payroll + staff namesakes are ambiguous');
  assert.equal(namesake.rows[2]!.target, null, 'same name, different CNIC is not matched');
  assert.ok(namesake.rows[2]!.errors[0]!.includes('CNIC is different'));
  const crossed = planImport({
    rows: [row(2, { name: 'Ayesha Khan', email: 'ayesha@example.com', cnic: '35202-1111111-1' })],
    target: { year: 2026, month: 9 },
    roster,
    staff,
    inRun: new Map(),
    runStatus: null,
  });
  assert.ok(crossed.rows[0]!.errors[0]!.includes('belongs to Bilal Driver'), 'email and CNIC of two people');
  const borrowedEmail = planImport({
    rows: [
      row(2, { name: 'Bilal Driver', cnic: '35202-1111111-1', email: 'omar@example.com' }),
      row(3, { name: 'Bilal Driver', cnic: '35202-1111111-1', email: 'sara@example.com' }),
    ],
    target: { year: 2026, month: 9 },
    roster,
    staff,
    inRun: new Map(),
    runStatus: null,
  });
  for (const r of borrowedEmail.rows) {
    assert.equal(r.target, null, `row ${r.row}: a staff member's email never becomes someone else's payslip address`);
    assert.ok(r.errors.some((e) => e.includes('belongs to')), `row ${r.row}: reported`);
  }
  console.log('payroll import ok');
}

async function main(): Promise<void> {
  mathChecks();
  csvChecks();
  await payslipChecks();
  importChecks();
  permissionChecks();
  console.log('\npayroll checks passed');
}

main().catch((err) => {
  console.error('payroll check failed:', err);
  process.exitCode = 1;
});
