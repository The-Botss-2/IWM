'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  portalChangePasswordSchema,
  type InvoiceStatus,
  type PortalChangePasswordInput,
  type PortalClientSummary,
  type PortalInvoiceDetail,
  type PortalMe,
  type PortalTask,
  type TaskStatus,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { saveFile } from '@/lib/save-file';
import { sessionQueryKey } from '@/lib/session-query';
import { markErrorReported, toast, toastError, toastErrorMessage } from '@/lib/toast';

/**
 * Client portal data and behaviour. Every cache key starts with 'portal';
 * client-scoped keys carry the client id second, so switching clients never
 * serves one client's data under another's page.
 *
 * The server decides everything a portal person may see (404 for another
 * client's ids, 403 for billing unless they are the main contact). Anything
 * role-shaped here is a UX hint.
 */
export const portalKeys = {
  me: ['portal', 'me'] as const,
  overview: (clientId: string) => ['portal', clientId, 'overview'] as const,
  projects: (clientId: string) => ['portal', clientId, 'projects'] as const,
  project: (clientId: string, projectId: string) => ['portal', clientId, 'projects', projectId] as const,
  documents: (clientId: string) => ['portal', clientId, 'documents'] as const,
  document: (clientId: string, documentId: string) =>
    ['portal', clientId, 'documents', documentId] as const,
  invoices: (clientId: string) => ['portal', clientId, 'invoices'] as const,
  invoice: (clientId: string, invoiceId: string) => ['portal', clientId, 'invoices', invoiceId] as const,
  contracts: (clientId: string) => ['portal', clientId, 'contracts'] as const,
  payments: (clientId: string) => ['portal', clientId, 'payments'] as const,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** HTTP status of a failed call. 0 means the server could not be reached. */
export function portalErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Offline, rate limited or a server fault: worth another try. */
function isTransient(err: unknown): boolean {
  const status = portalErrorStatus(err);
  return status === 0 || status === 429 || (status !== null && status >= 500);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * The signed-in client person and the clients they reach. Only the portal
 * gate calls this, and only for a CLIENT account (staff get a 403). It gates
 * the whole portal, so transient failures retry with backoff instead of
 * dropping straight to an error screen.
 */
export function usePortalMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: () => getApi().portal.me(),
    enabled,
    staleTime: 60_000,
    retry: (failureCount, err) => isTransient(err) && failureCount < 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  });
}

/**
 * Keeps the portal honest when access changes underneath the page.
 *
 * - A 401 means the session ended: it expired, or a password change on
 *   another device signed this one out. Re-check the session rather than
 *   guess; the gate sends the person to sign-in once `/auth/me` agrees.
 * - A 404 on client data can mean the person's access to that client was
 *   withdrawn. Refresh `me`, so the client layout (or the gate, when no
 *   client is left) can say so instead of a bare load error.
 *
 * A 403 is never read as signed out: billing returns it to everyone but the
 * main contact.
 */
export function usePortalAccessWatch() {
  const qc = useQueryClient();
  useEffect(() => {
    const recheck = (err: unknown) => {
      if (portalErrorStatus(err) === 401) void qc.invalidateQueries({ queryKey: sessionQueryKey });
    };
    const stopQueries = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const [root, scope] = event.query.queryKey;
      if (root !== 'portal') return;
      recheck(event.action.error);
      if (scope !== 'me' && portalErrorStatus(event.action.error) === 404) {
        void qc.invalidateQueries({ queryKey: portalKeys.me });
      }
    });
    // Mutations carry no key, but only portal ones run while the gate is
    // mounted (password change, invoice PDF).
    const stopMutations = qc.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      recheck(event.action.error);
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [qc]);
}

/**
 * Sign out, clear every cached answer, and leave for the sign-in page.
 *
 * Done means the server ended the session, or had none to end (Better Auth
 * answers 400 and clears the cookie then; 401 means the same). Anything else
 * (offline, rate limited, an origin check, a server fault) may have left the
 * session alive, and walking away from it would leave a shared device signed
 * in, so the person stays and is told.
 */
export function usePortalSignOut() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    meta: { errorTitle: "Couldn't sign out" },
    mutationFn: async () => {
      const res = await authClient.signOut();
      if (res.error && res.error.status !== 400 && res.error.status !== 401) {
        throw new Error('Sign-out failed.');
      }
    },
    onSuccess: () => {
      qc.clear();
      router.replace('/sign-in');
    },
    onError: () =>
      toastErrorMessage("Couldn't sign out", {
        description: 'You are still signed in. Try again in a moment.',
      }),
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export type PortalSection = 'overview' | 'projects' | 'documents' | 'signatures' | 'billing';

const PORTAL_SECTIONS: readonly PortalSection[] = [
  'overview',
  'projects',
  'documents',
  'signatures',
  'billing',
];

const SECTION_LABEL: Record<PortalSection, string> = {
  overview: 'Overview',
  projects: 'Projects',
  documents: 'Documents',
  signatures: 'Signatures',
  billing: 'Billing',
};

export interface PortalLocation {
  /** The client segment of the URL, not yet checked against `me.clients`. */
  clientId: string | null;
  /** The section under that client; null on /portal and /portal/account. */
  section: PortalSection | null;
  /** True on /portal/account. */
  account: boolean;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parsePortalPath(pathname: string): PortalLocation {
  const [, root, first, second] = pathname.split('/');
  if (root !== 'portal' || !first) return { clientId: null, section: null, account: false };
  if (first === 'account') return { clientId: null, section: null, account: true };
  const section = !second
    ? 'overview'
    : ((PORTAL_SECTIONS as readonly string[]).includes(second) ? (second as PortalSection) : null);
  return { clientId: safeDecode(first), section, account: false };
}

export function usePortalLocation(): PortalLocation {
  const pathname = usePathname();
  return useMemo(() => parsePortalPath(pathname ?? ''), [pathname]);
}

export function portalHref(clientId: string, section: PortalSection = 'overview'): string {
  const base = `/portal/${encodeURIComponent(clientId)}`;
  return section === 'overview' ? base : `${base}/${section}`;
}

export function portalProjectHref(clientId: string, projectId: string): string {
  return `${portalHref(clientId, 'projects')}/${encodeURIComponent(projectId)}`;
}

export function portalDocumentHref(clientId: string, documentId: string): string {
  return `${portalHref(clientId, 'documents')}/${encodeURIComponent(documentId)}`;
}

export function portalInvoiceHref(clientId: string, invoiceId: string): string {
  return `${portalHref(clientId, 'billing')}/invoices/${encodeURIComponent(invoiceId)}`;
}

export const PORTAL_ACCOUNT_HREF = '/portal/account';

/**
 * The client the portal is showing: the one in the URL, else the last one
 * visited (so /portal/account keeps its header and nav), else the first.
 */
export function useResolvedPortalClient(me: PortalMe): PortalClientSummary | null {
  const location = usePortalLocation();
  const [lastId, setLastId] = useState<string | null>(null);
  const fromUrl = useMemo(
    () => me.clients.find((c) => c.id === location.clientId) ?? null,
    [me, location.clientId],
  );
  useEffect(() => {
    if (fromUrl) setLastId(fromUrl.id);
  }, [fromUrl]);
  return useMemo(
    () => fromUrl ?? me.clients.find((c) => c.id === lastId) ?? me.clients[0] ?? null,
    [fromUrl, lastId, me],
  );
}

export interface PortalNavItem {
  section: PortalSection;
  label: string;
  href: string;
  active: boolean;
}

/** The section tabs for one client. Billing is listed for the main contact only. */
export function usePortalNav(client: PortalClientSummary | null): PortalNavItem[] {
  const location = usePortalLocation();
  return useMemo(() => {
    if (!client) return [];
    return PORTAL_SECTIONS.filter((s) => s !== 'billing' || client.canSeeBilling).map((section) => ({
      section,
      label: SECTION_LABEL[section],
      href: portalHref(client.id, section),
      active: location.clientId === client.id && location.section === section,
    }));
  }, [client, location]);
}

/**
 * Where the client switcher sends you: the same section for the other
 * client (ids below a section belong to one client, so its list page), or
 * that client's overview when the section does not apply to them.
 */
export function portalSwitchHref(target: PortalClientSummary, location: PortalLocation): string {
  const section = location.section ?? 'overview';
  if (section === 'billing' && !target.canSeeBilling) return portalHref(target.id);
  return portalHref(target.id, section);
}

// ---------------------------------------------------------------------------
// Overview and projects
// ---------------------------------------------------------------------------

export function usePortalOverview(clientId: string) {
  return useQuery({
    queryKey: portalKeys.overview(clientId),
    queryFn: () => getApi().portal.overview(clientId),
  });
}

export function usePortalProjects(clientId: string) {
  return useQuery({
    queryKey: portalKeys.projects(clientId),
    queryFn: () => getApi().portal.projects(clientId),
  });
}

export function usePortalProject(clientId: string, projectId: string) {
  return useQuery({
    queryKey: portalKeys.project(clientId, projectId),
    queryFn: () => getApi().portal.project(clientId, projectId),
  });
}

const TASK_ORDER: Record<TaskStatus, number> = {
  IN_PROGRESS: 0,
  IN_REVIEW: 1,
  TODO: 2,
  BACKLOG: 3,
  DONE: 4,
  CANCELLED: 5,
};

/**
 * What is moving first, then what is next, finished work last. The API
 * orders by the status enum (backlog first), which buries the work a client
 * most wants to see. Within a status the team's own order is kept.
 */
export function useOrderedPortalTasks(tasks: readonly PortalTask[] | undefined): PortalTask[] {
  return useMemo(
    () => (tasks ? [...tasks].sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status]) : []),
    [tasks],
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function usePortalDocuments(clientId: string) {
  return useQuery({
    queryKey: portalKeys.documents(clientId),
    queryFn: () => getApi().portal.documents(clientId),
  });
}

export function usePortalDocument(clientId: string, documentId: string) {
  return useQuery({
    queryKey: portalKeys.document(clientId, documentId),
    queryFn: () => getApi().portal.document(clientId, documentId),
  });
}

// ---------------------------------------------------------------------------
// Billing (main contact only)
// ---------------------------------------------------------------------------

/** `enabled` is false for anyone who is not the main contact: skip the 403. */
export function usePortalInvoices(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: portalKeys.invoices(clientId),
    queryFn: () => getApi().portal.invoices(clientId),
    enabled,
  });
}

export function usePortalInvoice(clientId: string, invoiceId: string, enabled: boolean) {
  return useQuery({
    queryKey: portalKeys.invoice(clientId, invoiceId),
    queryFn: () => getApi().portal.invoice(clientId, invoiceId),
    enabled,
  });
}

export function usePortalContracts(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: portalKeys.contracts(clientId),
    queryFn: () => getApi().portal.contracts(clientId),
    enabled,
  });
}

export function usePortalPayments(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: portalKeys.payments(clientId),
    queryFn: () => getApi().portal.payments(clientId),
    enabled,
  });
}

/**
 * Cancelled and refunded invoices are not owed, whatever their arithmetic
 * balance says, so they never show one.
 */
export function invoiceShowsBalance(status: InvoiceStatus): boolean {
  return status !== 'CANCELLED' && status !== 'REFUNDED';
}

function isPositive(amount: string): boolean {
  return Number(amount) > 0;
}

/** What is still owed on an invoice, or null when nothing is. */
export function invoiceAmountDue(invoice: { status: InvoiceStatus; balance: string }): string | null {
  return invoiceShowsBalance(invoice.status) && isPositive(invoice.balance) ? invoice.balance : null;
}

function negate(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
}

export interface InvoiceTotalRow {
  key: 'subtotal' | 'discount' | 'tax' | 'total' | 'paid' | 'balance';
  label: string;
  amount: string;
  strong?: boolean;
}

/**
 * The totals block and column choices for an invoice, following what the
 * invoice PDF prints: discount and tax only when there is some, payments
 * subtracted, and the balance still due. Unlike the PDF, "Paid" shows even
 * at zero: this is a live view, and "nothing received yet" is an answer.
 */
export function usePortalInvoiceBreakdown(invoice: PortalInvoiceDetail | undefined) {
  return useMemo(() => {
    if (!invoice) return null;
    const totals: InvoiceTotalRow[] = [{ key: 'subtotal', label: 'Subtotal', amount: invoice.subtotal }];
    if (isPositive(invoice.discountAmount)) {
      totals.push({ key: 'discount', label: 'Discount', amount: negate(invoice.discountAmount) });
    }
    if (isPositive(invoice.taxAmount)) {
      totals.push({ key: 'tax', label: 'Tax', amount: invoice.taxAmount });
    }
    totals.push({ key: 'total', label: 'Total', amount: invoice.total, strong: true });
    totals.push({
      key: 'paid',
      label: 'Paid',
      amount: isPositive(invoice.amountPaid) ? negate(invoice.amountPaid) : invoice.amountPaid,
    });
    if (invoiceShowsBalance(invoice.status)) {
      totals.push({ key: 'balance', label: 'Balance due', amount: invoice.balance, strong: true });
    }
    return {
      totals,
      /** A tax column that reads "0%" on every line is noise. */
      showTaxRate: invoice.lineItems.some((l) => isPositive(l.taxRate)),
      discountedLineIds: new Set(
        invoice.lineItems.filter((l) => isPositive(l.discountRate)).map((l) => l.id),
      ),
    };
  }, [invoice]);
}

/** Streams the PDF through the credentialed client and saves it on any shell. */
export function usePortalInvoicePdf(clientId: string) {
  return useMutation({
    meta: { errorTitle: "Couldn't download invoice" },
    mutationFn: async (invoice: { id: string; number: string }) => {
      const { blob, filename } = await getApi().portal.invoicePdf(clientId, invoice.id);
      const fallback = `Invoice ${invoice.number}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
      await saveFile(blob, filename ?? fallback);
    },
  });
}

const BILLING_TABS = ['invoices', 'contracts', 'payments'] as const;
export type PortalBillingTab = (typeof BILLING_TABS)[number];

/** The billing tab lives in `?tab=` so a refresh or a shared link keeps it. */
export function usePortalBillingTab(): [PortalBillingTab, (next: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = (BILLING_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as PortalBillingTab)
    : 'invoices';
  const setTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'invoices') params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  return [tab, setTab];
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * The shared change-password schema plus a confirmation field. The current
 * password is restated only to give its empty state a readable message; the
 * limits match the shared schema, which the API validates against.
 */
export const portalPasswordFormSchema = portalChangePasswordSchema
  .extend({
    currentPassword: z.string().min(1, 'Enter your current password.').max(128),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match.',
  });
export type PortalPasswordFormValues = z.infer<typeof portalPasswordFormSchema>;

function isWrongPassword(err: unknown): boolean {
  return (err as { problem?: { code?: unknown } } | null)?.problem?.code === 'wrong-password';
}

/** Form state and submit handler for changing a portal password. */
export function usePortalPasswordForm() {
  const form = useForm<PortalPasswordFormValues>({
    resolver: zodResolver(portalPasswordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const change = useMutation({
    meta: { errorTitle: "Couldn't change password" },
    mutationFn: (input: PortalChangePasswordInput) => getApi().portal.changePassword(input),
  });
  const { reset, setError } = form;
  const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await change.mutateAsync({ currentPassword, newPassword });
      reset();
      toast.success('Password changed. Your other devices have been signed out.');
    } catch (err) {
      if (isWrongPassword(err)) {
        // Shown inline on the field instead of as a toast.
        markErrorReported();
        setError(
          'currentPassword',
          { message: "That isn't your current password." },
          { shouldFocus: true },
        );
        return;
      }
      toastError(err, "Couldn't change your password");
    }
  });
  return { form, onSubmit, isSubmitting: change.isPending };
}
