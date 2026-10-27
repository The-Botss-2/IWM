import { Prisma } from '@botss/database';

import { D, round2 } from './serialize';

/**
 * The transaction-scoped Prisma client handed to `recalcContract`. Typed
 * loosely because Prisma's `$transaction` callback client is an
 * `Omit<PrismaClient, ...>` whose exact shape depends on the extension stack,
 * and pinning it here would couple this helper to the soft-delete extension.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type TxClient = any;

function statusFor(paid: Prisma.Decimal, total: Prisma.Decimal) {
  if (paid.lte(0)) return 'NOT_PAID' as const;
  // `gte`, not `eq`: an overpayment (client rounded up, or paid a late fee) is
  // still fully paid, and must not leave the contract stuck on PARTIAL.
  if (total.gt(0) && paid.gte(total)) return 'PAID' as const;
  // A zero-value contract with money against it is fully paid, not partial.
  if (total.lte(0)) return 'PAID' as const;
  return 'PARTIAL' as const;
}

/**
 * Recompute every cached total on a contract and its milestones FROM SCRATCH.
 *
 * Must be called inside the caller's `$transaction` from every path that
 * touches a payment or a milestone amount.
 *
 * It deliberately never uses `{ increment }`. Full recomputation is idempotent,
 * so two concurrent payment inserts converge on the right answer without row
 * locks, and a bug that double-fires the recalc is harmless. An increment would
 * be wrong in both cases.
 *
 * Ordering:
 *   1. Sum non-voided payments per milestone.
 *   2. Write each milestone's `amountPaid` + `paymentStatus`.
 *   3. Derive contract `totalValue` (milestone sum for milestone-billed
 *      contracts, the stored value for one-time ones).
 *   4. Sum ALL non-voided payments on the contract - milestone-scoped and
 *      contract-level alike - for the contract's `amountPaid`.
 *   5. Refresh `baseTotalValue` at the booked rate.
 */
export async function recalcContract(
  tx: TxClient,
  contractId: string,
): Promise<void> {
  const contract = await tx.contract.findUnique({
    where: { id: contractId },
    select: {
      id: true,
      billingModel: true,
      totalValue: true,
      fxRateToBase: true,
    },
  });
  if (!contract) return;

  const milestones = await tx.contractMilestone.findMany({
    where: { contractId },
    select: { id: true, amount: true, status: true },
  });

  // One grouped read rather than a query per milestone.
  const sums: Array<{ milestoneId: string | null; _sum: { amount: Prisma.Decimal | null } }> =
    await tx.payment.groupBy({
      by: ['milestoneId'],
      where: { contractId, voidedAt: null },
      _sum: { amount: true },
    });

  const paidByMilestone = new Map<string, Prisma.Decimal>();
  let contractPaid = new D(0);
  for (const row of sums) {
    const amt = new D(row._sum.amount ?? 0);
    contractPaid = contractPaid.plus(amt);
    // A null milestoneId is a contract-level payment: it counts toward the
    // contract but belongs to no milestone.
    if (row.milestoneId) paidByMilestone.set(row.milestoneId, amt);
  }

  for (const m of milestones) {
    const paid = paidByMilestone.get(m.id) ?? new D(0);
    const amount = new D(m.amount);
    await tx.contractMilestone.update({
      where: { id: m.id },
      data: {
        amountPaid: round2(paid),
        paymentStatus: statusFor(paid, amount),
      },
    });
  }

  // For milestone-billed contracts the milestone sum IS the contract value, so
  // adding or removing a stage moves the total. CANCELLED stages are excluded:
  // work that was called off is not owed. One-time contracts keep the value
  // the finance manager entered.
  const totalValue =
    contract.billingModel === 'ONE_TIME'
      ? new D(contract.totalValue)
      : milestones
          .filter((m: { status: string }) => m.status !== 'CANCELLED')
          .reduce((acc: Prisma.Decimal, m: { amount: Prisma.Decimal }) => acc.plus(new D(m.amount)), new D(0));

  const fx = new D(contract.fxRateToBase);

  await tx.contract.update({
    where: { id: contractId },
    data: {
      totalValue: round2(totalValue),
      amountPaid: round2(contractPaid),
      paymentStatus: statusFor(contractPaid, totalValue),
      baseTotalValue: round2(totalValue.times(fx)),
    },
  });
}
