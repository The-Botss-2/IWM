'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContractWithMilestones,
  CreateContractInput,
  CreateExpenseInput,
  CreateMilestoneInput,
  CreatePaymentInput,
  CreatePaymentSourceInput,
  FinanceSummaryQuery,
  LinkMilestoneWorkInput,
  ListContractsQuery,
  ListExpensesQuery,
  ListPaymentsQuery,
  ReorderMilestonesInput,
  ReorderPaymentSourcesInput,
  UpdateContractInput,
  UpdateExpenseInput,
  UpdateMilestoneInput,
  UpdatePaymentInput,
  UpdatePaymentSourceInput,
  VoidPaymentInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

/* -------------------------------------------------------------------------
 * Query keys
 *
 * Every money mutation invalidates BOTH the thing it changed and the derived
 * caches - the server recomputes contract totals inside its own transaction,
 * so a payment write silently changes the contract row and the summary. Not
 * invalidating them leaves the UI showing stale totals that look like a bug in
 * the recalc.
 * ---------------------------------------------------------------------- */

const contractsKey = (q?: Partial<ListContractsQuery>) =>
  ['finance', 'contracts', q ?? {}] as const;
const contractKey = (id: string) => ['finance', 'contract', id] as const;
const paymentsKey = (q?: Partial<ListPaymentsQuery>) =>
  ['finance', 'payments', q ?? {}] as const;
const expensesKey = (q?: Partial<ListExpensesQuery>) =>
  ['finance', 'expenses', q ?? {}] as const;
const paymentSourcesKey = (includeInactive = false) =>
  ['finance', 'payment-sources', includeInactive] as const;
const financeSummaryKey = (q: FinanceSummaryQuery) =>
  ['finance', 'summary', q.from, q.to, q.projectId ?? null, q.clientId ?? null] as const;
const awaitingPaymentKey = () => ['finance', 'awaiting-payment'] as const;

const READ_OPTS = {
  staleTime: 30_000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Everything a money write can invalidate. */
function invalidateMoney(
  qc: ReturnType<typeof useQueryClient>,
  contractId?: string | null,
) {
  void qc.invalidateQueries({ queryKey: ['finance', 'contracts'] });
  void qc.invalidateQueries({ queryKey: ['finance', 'payments'] });
  void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
  void qc.invalidateQueries({ queryKey: awaitingPaymentKey() });
  if (contractId) {
    void qc.invalidateQueries({ queryKey: contractKey(contractId) });
  }
}

/* ------------------------------------------------------------------ reads */

export function useContracts(q?: Partial<ListContractsQuery>) {
  return useQuery({
    queryKey: contractsKey(q),
    queryFn: () => getApi().finance.listContracts(q),
    ...READ_OPTS,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKey(id),
    queryFn: () => getApi().finance.getContract(id),
    enabled: !!id,
    ...READ_OPTS,
  });
}

export function usePayments(q?: Partial<ListPaymentsQuery>) {
  return useQuery({
    queryKey: paymentsKey(q),
    queryFn: () => getApi().finance.listPayments(q),
    ...READ_OPTS,
  });
}

export function useExpenses(q?: Partial<ListExpensesQuery>) {
  return useQuery({
    queryKey: expensesKey(q),
    queryFn: () => getApi().finance.listExpenses(q),
    ...READ_OPTS,
  });
}

export function usePaymentSources(includeInactive = false) {
  return useQuery({
    queryKey: paymentSourcesKey(includeInactive),
    queryFn: () => getApi().finance.listPaymentSources({ includeInactive }),
    // Rails change maybe twice a year; no point re-fetching them every 30s.
    staleTime: 300_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useFinanceSummary(q: FinanceSummaryQuery, enabled = true) {
  return useQuery({
    queryKey: financeSummaryKey(q),
    queryFn: () => getApi().finance.summary(q),
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useAwaitingPayment(enabled = true) {
  return useQuery({
    queryKey: awaitingPaymentKey(),
    queryFn: () => getApi().finance.awaitingPayment(),
    enabled,
    ...READ_OPTS,
  });
}

export function useFinanceProjectPicker(q?: string) {
  return useQuery({
    queryKey: ['finance', 'pick', 'projects', q ?? ''],
    queryFn: () => getApi().finance.pickProjects(q),
    staleTime: 120_000,
  });
}

export function useFinanceClientPicker(q?: string) {
  return useQuery({
    queryKey: ['finance', 'pick', 'clients', q ?? ''],
    queryFn: () => getApi().finance.pickClients(q),
    staleTime: 120_000,
  });
}

export function useFinanceSprintPicker(projectId: string | null) {
  return useQuery({
    queryKey: ['finance', 'pick', 'sprints', projectId ?? ''],
    queryFn: () => getApi().finance.pickSprints(projectId as string),
    enabled: !!projectId,
    staleTime: 120_000,
  });
}

export function useFinanceTaskPicker(projectId: string | null, q?: string) {
  return useQuery({
    queryKey: ['finance', 'pick', 'tasks', projectId ?? '', q ?? ''],
    queryFn: () => getApi().finance.pickTasks(projectId as string, q),
    enabled: !!projectId,
    staleTime: 120_000,
  });
}

/* -------------------------------------------------------------- contracts */

export function useCreateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContractInput) => getApi().finance.createContract(input),
    onSuccess: (created) => {
      qc.setQueryData(contractKey(created.id), created);
      invalidateMoney(qc, created.id);
    },
    meta: { successMessage: 'Contract created.', errorTitle: "Couldn't create contract" },
  });
}

export function useUpdateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContractInput }) =>
      getApi().finance.updateContract(id, input),
    onSuccess: (updated) => {
      qc.setQueryData(contractKey(updated.id), updated);
      invalidateMoney(qc, updated.id);
    },
    meta: { successMessage: 'Contract saved.', errorTitle: "Couldn't update contract" },
  });
}

export function useDeleteContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().finance.deleteContract(id),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: contractKey(id) });
      invalidateMoney(qc);
    },
    meta: { successMessage: 'Contract deleted.', errorTitle: "Couldn't delete contract" },
  });
}

/* ------------------------------------------------------------- milestones */

export function useCreateMilestone(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMilestoneInput) =>
      getApi().finance.createMilestone(contractId, input),
    onSuccess: () => invalidateMoney(qc, contractId),
    meta: { successMessage: 'Milestone added.', errorTitle: "Couldn't add milestone" },
  });
}

export function useUpdateMilestone(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMilestoneInput }) =>
      getApi().finance.updateMilestone(id, input),
    onSuccess: () => invalidateMoney(qc, contractId),
    meta: { successMessage: 'Milestone saved.', errorTitle: "Couldn't update milestone" },
  });
}

export function useDeleteMilestone(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().finance.deleteMilestone(id),
    onSuccess: () => invalidateMoney(qc, contractId),
    meta: { successMessage: 'Milestone deleted.', errorTitle: "Couldn't delete milestone" },
  });
}

/**
 * `ids` must be the contract's FULL milestone list in the new order (the
 * server refuses a subset). Optimistic: the rows move at once and snap back
 * on error.
 */
export function useReorderMilestones(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderMilestonesInput) =>
      getApi().finance.reorderMilestones(contractId, input),
    onMutate: async (input) => {
      const key = contractKey(contractId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ContractWithMilestones>(key);
      if (previous) {
        const byId = new Map(previous.milestones.map((m) => [m.id, m]));
        const milestones = input.ids.flatMap((id, position) => {
          const m = byId.get(id);
          return m ? [{ ...m, position }] : [];
        });
        qc.setQueryData<ContractWithMilestones>(key, { ...previous, milestones });
      }
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(contractKey(contractId), ctx.previous);
    },
    // Order moves no money, so only this contract is re-read to confirm the
    // stored positions. Nothing on the page edits the contract in place.
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractKey(contractId) }),
    meta: { errorTitle: "Couldn't reorder milestones" },
  });
}

export function useLinkMilestoneWork(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: LinkMilestoneWorkInput }) =>
      getApi().finance.linkMilestoneWork(id, input),
    onSuccess: () => invalidateMoney(qc, contractId),
    meta: { successMessage: 'Project work linked.', errorTitle: "Couldn't link project work" },
  });
}

export function useDeliverMilestone(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().finance.deliverMilestone(id),
    onSuccess: () => invalidateMoney(qc, contractId),
    meta: { successMessage: 'Milestone marked delivered.', errorTitle: "Couldn't mark delivered" },
  });
}

/* ---------------------------------------------------------------- payments */

export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) => getApi().finance.createPayment(input),
    onSuccess: (created) => {
      toast.success('Payment recorded.');
      invalidateMoney(qc, created.contractId);
    },
    meta: { errorTitle: "Couldn't record payment" },
  });
}

export function useUpdatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePaymentInput }) =>
      getApi().finance.updatePayment(id, input),
    onSuccess: (updated) => {
      invalidateMoney(qc, updated.contractId);
      // The server re-syncs the invoice's paid total and status inside the
      // same transaction. Invoices are only edited on their own page, never
      // next to a payment list, so re-reading the list and that invoice
      // cannot clobber a draft.
      if (updated.invoiceId) {
        void qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
        void qc.invalidateQueries({ queryKey: ['invoices', 'detail', updated.invoiceId] });
      }
    },
    meta: { successMessage: 'Payment updated.', errorTitle: "Couldn't update payment" },
  });
}

/** Payments are voided, never deleted - the row stays for the audit trail. */
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: VoidPaymentInput }) =>
      getApi().finance.voidPayment(id, input),
    onSuccess: (voided) => {
      toast.success('Payment voided.');
      invalidateMoney(qc, voided.contractId);
    },
    meta: { errorTitle: "Couldn't void payment" },
  });
}

/* ---------------------------------------------------------------- expenses */

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) => getApi().finance.createExpense(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance', 'expenses'] });
      void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
    },
    meta: { successMessage: 'Expense recorded.', errorTitle: "Couldn't record expense" },
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateExpenseInput }) =>
      getApi().finance.updateExpense(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance', 'expenses'] });
      void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
    },
    meta: { successMessage: 'Expense updated.', errorTitle: "Couldn't update expense" },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().finance.deleteExpense(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance', 'expenses'] });
      void qc.invalidateQueries({ queryKey: ['finance', 'summary'] });
    },
    meta: { successMessage: 'Expense deleted.', errorTitle: "Couldn't delete expense" },
  });
}

/* --------------------------------------------------------- payment sources */

export function useCreatePaymentSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentSourceInput) =>
      getApi().finance.createPaymentSource(input),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['finance', 'payment-sources'] }),
    meta: { successMessage: 'Payment source added.', errorTitle: "Couldn't add payment source" },
  });
}

export function useUpdatePaymentSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePaymentSourceInput }) =>
      getApi().finance.updatePaymentSource(id, input),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['finance', 'payment-sources'] }),
    meta: { errorTitle: "Couldn't update payment source" },
  });
}

type PaymentSourceList = Awaited<ReturnType<ReturnType<typeof getApi>['finance']['listPaymentSources']>>;

/**
 * `ids` is the full list in the new order. Optimistic across every cached
 * source list (active-only and with inactive): each keeps its own rows,
 * re-sorted by the new order. Rolled back on error, nothing refetched - the
 * order shown is exactly what the server stores.
 */
export function useReorderPaymentSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderPaymentSourcesInput) =>
      getApi().finance.reorderPaymentSources(input),
    onMutate: async (input) => {
      const filter = { queryKey: ['finance', 'payment-sources'] };
      await qc.cancelQueries(filter);
      const snapshots = qc.getQueriesData<PaymentSourceList>(filter);
      const rank = new Map(input.ids.map((id, i) => [id, i]));
      qc.setQueriesData<PaymentSourceList>(filter, (curr) =>
        curr
          ? {
              ...curr,
              items: [...curr.items].sort(
                (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
              ),
            }
          : curr,
      );
      return { snapshots };
    },
    onError: (_err, _input, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    meta: { errorTitle: "Couldn't reorder payment sources" },
  });
}

export function useDeletePaymentSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().finance.deletePaymentSource(id),
    onSuccess: (res) => {
      // A rail with payments against it can only ever be deactivated - say so
      // rather than letting the row silently reappear under "show inactive".
      if (res.deactivated) {
        toast.success('Deactivated. Existing payments keep this source.');
      } else {
        toast.success('Payment source removed.');
      }
      void qc.invalidateQueries({ queryKey: ['finance', 'payment-sources'] });
    },
    meta: { errorTitle: "Couldn't remove payment source" },
  });
}
