import { z } from 'zod';
import {
  awaitingPaymentItemSchema,
  contractListItemSchema,
  contractMilestoneWithWorkSchema,
  contractWithMilestonesSchema,
  type CreateContractInput,
  type CreateExpenseInput,
  type CreateMilestoneInput,
  type CreatePaymentInput,
  type CreatePaymentSourceInput,
  expenseWithRefsSchema,
  financeClientPickSchema,
  financeProjectPickSchema,
  financeSprintPickSchema,
  financeSummarySchema,
  financeTaskPickSchema,
  type FinanceSummaryQuery,
  type LinkMilestoneWorkInput,
  type ListContractsQuery,
  type ListExpensesQuery,
  type ListPaymentSourcesQuery,
  type ListPaymentsQuery,
  listResponseSchema,
  paymentSourceWithUsageSchema,
  paymentWithSourceSchema,
  type ReorderMilestonesInput,
  type ReorderPaymentSourcesInput,
  type UpdateContractInput,
  type UpdateExpenseInput,
  type UpdateMilestoneInput,
  type UpdatePaymentInput,
  type UpdatePaymentSourceInput,
  type VoidPaymentInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const removeSourceSchema = z.object({
  ok: z.boolean(),
  /** True when the rail had payments and was deactivated instead of deleted. */
  deactivated: z.boolean(),
});

const contractListSchema = listResponseSchema(contractListItemSchema);
const paymentListSchema = listResponseSchema(paymentWithSourceSchema);
const expenseListSchema = listResponseSchema(expenseWithRefsSchema);
const sourceListSchema = z.object({
  items: z.array(paymentSourceWithUsageSchema),
});
const awaitingSchema = z.object({ items: z.array(awaitingPaymentItemSchema) });
const projectPickSchema = z.object({ items: z.array(financeProjectPickSchema) });
const clientPickSchema = z.object({ items: z.array(financeClientPickSchema) });
const sprintPickSchema = z.object({ items: z.array(financeSprintPickSchema) });
const taskPickSchema = z.object({ items: z.array(financeTaskPickSchema) });

/**
 * One resource class for the whole Financials surface rather than six, so
 * registering it in `createClient()` is three edits instead of eighteen.
 */
export class FinanceResource {
  constructor(private readonly http: HttpClient) {}

  // --- contracts ---
  listContracts(query?: Partial<ListContractsQuery>) {
    return this.http.get('/finance/contracts', contractListSchema, query);
  }
  getContract(id: string) {
    return this.http.get(`/finance/contracts/${id}`, contractWithMilestonesSchema);
  }
  createContract(input: CreateContractInput) {
    return this.http.post('/finance/contracts', contractWithMilestonesSchema, input);
  }
  updateContract(id: string, input: UpdateContractInput) {
    return this.http.patch(
      `/finance/contracts/${id}`,
      contractWithMilestonesSchema,
      input,
    );
  }
  deleteContract(id: string) {
    return this.http.delete(`/finance/contracts/${id}`, okSchema);
  }

  // --- milestones ---
  createMilestone(contractId: string, input: CreateMilestoneInput) {
    return this.http.post(
      `/finance/contracts/${contractId}/milestones`,
      contractMilestoneWithWorkSchema,
      input,
    );
  }
  updateMilestone(id: string, input: UpdateMilestoneInput) {
    return this.http.patch(
      `/finance/milestones/${id}`,
      contractMilestoneWithWorkSchema,
      input,
    );
  }
  deleteMilestone(id: string) {
    return this.http.delete(`/finance/milestones/${id}`, okSchema);
  }
  reorderMilestones(contractId: string, input: ReorderMilestonesInput) {
    return this.http.patch(
      `/finance/contracts/${contractId}/milestones/reorder`,
      okSchema,
      input,
    );
  }
  /** Replaces the milestone's linked sprint / tasks - does not merge. */
  linkMilestoneWork(id: string, input: LinkMilestoneWorkInput) {
    return this.http.put(
      `/finance/milestones/${id}/work`,
      contractMilestoneWithWorkSchema,
      input,
    );
  }
  deliverMilestone(id: string) {
    return this.http.post(
      `/finance/milestones/${id}/deliver`,
      contractMilestoneWithWorkSchema,
      {},
    );
  }
  awaitingPayment() {
    return this.http.get('/finance/awaiting-payment', awaitingSchema);
  }

  // --- payments (voided, never deleted) ---
  listPayments(query?: Partial<ListPaymentsQuery>) {
    return this.http.get('/finance/payments', paymentListSchema, query);
  }
  createPayment(input: CreatePaymentInput) {
    return this.http.post('/finance/payments', paymentWithSourceSchema, input);
  }
  updatePayment(id: string, input: UpdatePaymentInput) {
    return this.http.patch(`/finance/payments/${id}`, paymentWithSourceSchema, input);
  }
  voidPayment(id: string, input: VoidPaymentInput) {
    return this.http.post(
      `/finance/payments/${id}/void`,
      paymentWithSourceSchema,
      input,
    );
  }

  // --- expenses ---
  listExpenses(query?: Partial<ListExpensesQuery>) {
    return this.http.get('/finance/expenses', expenseListSchema, query);
  }
  createExpense(input: CreateExpenseInput) {
    return this.http.post('/finance/expenses', expenseWithRefsSchema, input);
  }
  updateExpense(id: string, input: UpdateExpenseInput) {
    return this.http.patch(`/finance/expenses/${id}`, expenseWithRefsSchema, input);
  }
  deleteExpense(id: string) {
    return this.http.delete(`/finance/expenses/${id}`, okSchema);
  }

  // --- payment sources (org-scoped) ---
  listPaymentSources(query?: Partial<ListPaymentSourcesQuery>) {
    return this.http.get('/finance/payment-sources', sourceListSchema, query);
  }
  createPaymentSource(input: CreatePaymentSourceInput) {
    return this.http.post(
      '/finance/payment-sources',
      paymentSourceWithUsageSchema,
      input,
    );
  }
  updatePaymentSource(id: string, input: UpdatePaymentSourceInput) {
    return this.http.patch(
      `/finance/payment-sources/${id}`,
      paymentSourceWithUsageSchema,
      input,
    );
  }
  reorderPaymentSources(input: ReorderPaymentSourcesInput) {
    return this.http.patch('/finance/payment-sources/reorder', okSchema, input);
  }
  deletePaymentSource(id: string) {
    return this.http.delete(`/finance/payment-sources/${id}`, removeSourceSchema);
  }

  // --- reporting ---
  summary(query: FinanceSummaryQuery) {
    return this.http.get('/finance/summary', financeSummarySchema, query);
  }

  // --- pickers (see finance-pickers.controller.ts for why these exist) ---
  pickProjects(q?: string) {
    return this.http.get('/finance/pickers/projects', projectPickSchema, { q });
  }
  pickClients(q?: string) {
    return this.http.get('/finance/pickers/clients', clientPickSchema, { q });
  }
  pickSprints(projectId: string) {
    return this.http.get('/finance/pickers/sprints', sprintPickSchema, { projectId });
  }
  pickTasks(projectId: string, q?: string) {
    return this.http.get('/finance/pickers/tasks', taskPickSchema, { projectId, q });
  }
}
