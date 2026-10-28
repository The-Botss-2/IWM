'use client';

import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FinanceSummary } from '@botss/shared-types';

import { PaymentStatusBadge } from '@/components/financials/finance-badges';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAwaitingPayment } from '@/hooks/use-finance';
import { formatCurrency } from '@/lib/money';

/**
 * One categorical ramp, used consistently across both charts so a rail keeps
 * the same colour wherever it appears.
 */
const SERIES = ['#5B8DEF', '#2BB6A3', '#F2994A', '#9B7EDE', '#E5637E', '#6FCF97'];

export function FinanceOverview({
  summary,
  loading,
}: {
  summary: FinanceSummary | undefined;
  loading: boolean;
}) {
  const awaiting = useAwaitingPayment();

  if (loading || !summary) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const base = summary.baseCurrency;
  const fees = Number(summary.receivedGrossBase) - Number(summary.receivedBase);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Received"
          value={formatCurrency(summary.receivedBase, base)}
          hint={`${summary.paymentCount} payment${summary.paymentCount === 1 ? '' : 's'}, net of fees`}
        />
        <Kpi
          label="Spent"
          value={formatCurrency(summary.spentBase, base)}
          hint={`${summary.expenseCount} expense${summary.expenseCount === 1 ? '' : 's'}`}
        />
        <Kpi
          label="Net profit"
          value={formatCurrency(summary.netProfitBase, base)}
          hint="Received minus spent, this period"
          emphasis={Number(summary.netProfitBase) < 0 ? 'negative' : 'positive'}
        />
        <Kpi
          label="Outstanding"
          value={formatCurrency(summary.outstandingBase, base)}
          hint={
            Number(summary.overdueBase) > 0
              ? `${formatCurrency(summary.overdueBase, base)} overdue`
              : 'Owed on active contracts'
          }
        />
      </div>

      {/* Delivered but unpaid is the whole point of linking milestones to
          sprints, so it gets a panel rather than a buried column. */}
      {awaiting.data && awaiting.data.items.length > 0 ? (
        <section className="border-line bg-bg-surface rounded-md border">
          <header className="border-line flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Awaiting payment</h2>
            <span className="text-ink-muted text-xs">
              Delivered work that has not been paid for
            </span>
          </header>
          <ul className="divide-line divide-y" role="list">
            {awaiting.data.items.slice(0, 8).map((m) => (
              <li key={m.milestoneId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Link
                  href={`/financials/${m.contractId}?tab=milestones`}
                  className="font-medium hover:underline"
                >
                  {m.milestoneTitle}
                </Link>
                <span className="text-ink-muted text-xs">
                  {m.contractTitle}
                  {m.client ? ` · ${m.client.name}` : ''}
                </span>
                <PaymentStatusBadge status={m.paymentStatus} />
                <span className="ml-auto tabular-nums">
                  {formatCurrency(Number(m.amount) - Number(m.amountPaid), m.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Money in and out" subtitle={`Trailing 12 months, ${base}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={summary.monthly}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11 }}
                tickFormatter={(m: string) => m.slice(5)}
              />
              <YAxis tick={{ fontSize: 11 }} width={70} />
              <Tooltip formatter={(v) => formatCurrency(v as number, base)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="receivedBase" name="Received" fill={SERIES[1]} radius={[3, 3, 0, 0]} />
              <Bar dataKey="spentBase" name="Spent" fill={SERIES[4]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Where it came from" subtitle="By payment source">
          {summary.bySource.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={summary.bySource.map((s) => ({
                    name: s.name,
                    value: Number(s.amountBase),
                  }))}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {summary.bySource.map((_, i) => (
                    <Cell key={i} fill={SERIES[i % SERIES.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatCurrency(v as number, base)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Local vs international" subtitle="Share of money in">
          {summary.byRegion.length === 0 ? (
            <Empty />
          ) : (
            <ul className="space-y-2 p-4" role="list">
              {summary.byRegion.map((r) => (
                <li key={r.region} className="flex items-center justify-between text-sm">
                  <Badge tone={r.region === 'LOCAL' ? 'neutral' : 'info'}>
                    {r.region === 'LOCAL' ? 'Local' : 'International'}
                  </Badge>
                  <span className="tabular-nums">{formatCurrency(r.amountBase, base)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Outstanding by currency" subtitle="Exact, no conversion">
          {summary.outstandingByCurrency.length === 0 ? (
            <Empty />
          ) : (
            <ul className="space-y-2 p-4" role="list">
              {summary.outstandingByCurrency.map((c) => (
                <li key={c.currency} className="flex items-center justify-between text-sm">
                  <span className="text-ink-muted">{c.currency}</span>
                  <span className="tabular-nums">{formatCurrency(c.amount, c.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Costs" subtitle="Platform fees and expenses">
          <ul className="space-y-2 p-4 text-sm" role="list">
            <li className="flex items-center justify-between">
              <span className="text-ink-muted">Platform + FX fees</span>
              <span className="tabular-nums">{formatCurrency(fees, base)}</span>
            </li>
            {summary.byExpenseCategory.slice(0, 5).map((c) => (
              <li key={c.category} className="flex items-center justify-between">
                <span className="text-ink-muted">{c.category.toLowerCase()}</span>
                <span className="tabular-nums">{formatCurrency(c.amountBase, base)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: 'positive' | 'negative';
}) {
  return (
    <div className="border-line bg-bg-surface rounded-md border p-4">
      <p className="text-ink-muted text-xs uppercase tracking-wide">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          emphasis === 'negative' ? 'text-state-error' : ''
        }`}
      >
        {value}
      </p>
      {hint ? <p className="text-ink-muted mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-line bg-bg-surface rounded-md border">
      <header className="border-line border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="text-ink-muted text-xs">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Empty() {
  return <p className="text-ink-muted p-8 text-center text-sm">Nothing recorded in this period.</p>;
}
