'use client';

import {
  Banknote,
  FileText,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Users,
  Wallet,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Sub-tabs are query-driven (`?tab=`) rather than routed, matching
 * `project-view-tabs.tsx` and the client detail page. Keeps the URL shareable
 * without a route file per view.
 */
export const FINANCE_TABS = [
  'overview',
  'contracts',
  'payments',
  'expenses',
  'payroll',
  'invoices',
  'sources',
] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number];

export const DEFAULT_FINANCE_TAB: FinanceTab = 'overview';

const ICONS: Record<FinanceTab, typeof Wallet> = {
  overview: LayoutDashboard,
  contracts: ScrollText,
  payments: Banknote,
  expenses: Receipt,
  payroll: Users,
  invoices: FileText,
  sources: Wallet,
};

const LABELS: Record<FinanceTab, string> = {
  overview: 'Overview',
  contracts: 'Contracts',
  payments: 'Payments',
  expenses: 'Expenses',
  payroll: 'Payroll',
  invoices: 'Invoices',
  sources: 'Payment sources',
};

export function parseFinanceTab(value: string | null | undefined): FinanceTab {
  if (!value) return DEFAULT_FINANCE_TAB;
  return (FINANCE_TABS as readonly string[]).includes(value)
    ? (value as FinanceTab)
    : DEFAULT_FINANCE_TAB;
}

export function useFinanceTab(): {
  tab: FinanceTab;
  setTab: (next: FinanceTab) => void;
} {
  const router = useRouter();
  const params = useSearchParams();
  const tab = parseFinanceTab(params.get('tab'));
  const setTab = useCallback(
    (next: FinanceTab) => {
      const sp = new URLSearchParams(params.toString());
      if (next === DEFAULT_FINANCE_TAB) sp.delete('tab');
      else sp.set('tab', next);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [params, router],
  );
  return { tab, setTab };
}

export function FinancialsTabs({
  tab,
  onChange,
}: {
  tab: FinanceTab;
  onChange: (next: FinanceTab) => void;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onChange(v as FinanceTab)}>
      <TabsList className="overflow-x-auto">
        {FINANCE_TABS.map((t) => {
          const Icon = ICONS[t];
          return (
            <TabsTrigger key={t} value={t} className="shrink-0">
              <Icon className="h-4 w-4" aria-hidden />
              <span>{LABELS[t]}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

/* ---------------------------------------------------------------------- */

export const CONTRACT_TABS = [
  'overview',
  'milestones',
  'payments',
  'expenses',
  'invoices',
] as const;
export type ContractTab = (typeof CONTRACT_TABS)[number];

const CONTRACT_LABELS: Record<ContractTab, string> = {
  overview: 'Overview',
  milestones: 'Milestones',
  payments: 'Payments',
  expenses: 'Expenses',
  invoices: 'Invoices',
};

export function ContractTabs({
  tab,
  onChange,
  /** Hidden for ONE_TIME contracts, which have no stages to show. */
  showMilestones,
}: {
  tab: ContractTab;
  onChange: (next: ContractTab) => void;
  showMilestones: boolean;
}) {
  const visible = CONTRACT_TABS.filter((t) => t !== 'milestones' || showMilestones);
  return (
    <Tabs value={tab} onValueChange={(v) => onChange(v as ContractTab)}>
      <TabsList className="overflow-x-auto">
        {visible.map((t) => (
          <TabsTrigger key={t} value={t} className="shrink-0">
            {CONTRACT_LABELS[t]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
