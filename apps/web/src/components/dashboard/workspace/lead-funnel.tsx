'use client';

import { Layers } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import type { LeadStage } from '@botss/shared-types';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspaceLeads } from '@/hooks/use-leads';

const STAGES: { id: LeadStage; label: string; terminal?: 'win' | 'loss' }[] = [
  { id: 'NEW', label: 'New' },
  { id: 'QUALIFIED', label: 'Qualified' },
  { id: 'CONTACTED', label: 'Contacted' },
  { id: 'DEMO_SCHEDULED', label: 'Demo Scheduled' },
  { id: 'DEMO_COMPLETED', label: 'Demo Completed' },
  { id: 'PROPOSAL', label: 'Proposal' },
  { id: 'NEGOTIATION', label: 'Negotiation' },
  { id: 'WON', label: 'Won', terminal: 'win' },
  { id: 'LOST', label: 'Lost', terminal: 'loss' },
];

/**
 * Lead pipeline funnel. Each stage gets a horizontal bar sized relative
 * to the largest non-terminal stage; terminal Won / Lost rows are styled
 * separately so they don't dominate the chart's visual scale.
 */
export function LeadFunnelWidget() {
  // Leads are gated server-side. The widget hides itself for anyone without
  // access so the dashboard doesn't fire a guaranteed-403 fetch on every
  // render. Users who only have leads assigned to them still get the widget -
  // the funnel then charts their own leads, which is what the list returns.
  // The list is shared with the KPI strip's "Open leads" tile.
  const q = useWorkspaceLeads();
  const { canSeeLeads } = q;

  // All hooks must run on every render - the `canSeeLeads` early-return
  // moves below so the rules-of-hooks pass holds. The `useQuery` above
  // already disables the network call when `canSeeLeads` is false, so the
  // hook running for non-admins is cheap (no fetch).
  const { counts, maxOpen, totalOpen } = useMemo(() => {
    const c = new Map<LeadStage, number>();
    for (const s of STAGES) c.set(s.id, 0);
    for (const l of q.data?.items ?? []) {
      c.set(l.stage, (c.get(l.stage) ?? 0) + 1);
    }
    let max = 0;
    let openSum = 0;
    for (const s of STAGES) {
      if (s.terminal) continue;
      const v = c.get(s.id) ?? 0;
      if (v > max) max = v;
      openSum += v;
    }
    return { counts: c, maxOpen: max, totalOpen: openSum };
  }, [q.data]);

  if (!canSeeLeads) return null;

  const totalLeads = q.data?.items?.length ?? 0;

  return (
    <WidgetShell id="widget-ws-lead-funnel" title="Lead pipeline" icon={Layers} linkHref="/leads">
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <QueryError
          compact
          message="Couldn't load the lead pipeline."
          onRetry={() => void q.refetch()}
        />
      ) : totalLeads === 0 ? (
        <WidgetEmpty icon={Layers} message="No leads in the pipeline yet." />
      ) : (
        <>
          <div className="mb-3 flex items-end gap-2">
            <div className="text-ink text-2xl font-bold">{totalOpen}</div>
            <div className="text-ink-muted mb-1 text-xs">open leads</div>
          </div>
          <ul className="space-y-1.5" role="list">
            {STAGES.map((s) => {
              const v = counts.get(s.id) ?? 0;
              const pct = maxOpen === 0 ? 0 : (v / maxOpen) * 100;
              return (
                <FunnelRow key={s.id} label={s.label} value={v} pct={pct} terminal={s.terminal} />
              );
            })}
          </ul>
          <div className="text-ink-muted mt-3 text-[11px]">
            Conversion:{' '}
            <Link
              href="/leads?view=pipeline"
              className="text-brand-gradient font-medium hover:underline"
            >
              {totalLeads === 0
                ? '-'
                : `${Math.round(((counts.get('WON') ?? 0) / Math.max(1, totalLeads)) * 100)}%`}
            </Link>
            {' won · '}
            {`${Math.round(((counts.get('LOST') ?? 0) / Math.max(1, totalLeads)) * 100)}% lost`}
          </div>
        </>
      )}
    </WidgetShell>
  );
}

function FunnelRow({
  label,
  value,
  pct,
  terminal,
}: {
  label: string;
  value: number;
  pct: number;
  terminal?: 'win' | 'loss';
}) {
  const barBg =
    terminal === 'win'
      ? 'bg-brand-teal'
      : terminal === 'loss'
        ? 'bg-state-error/60'
        : 'bg-brand-gradient';
  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink">{label}</span>
        <span className="text-ink font-medium tabular-nums">{value}</span>
      </div>
      <div className="bg-bg-subtle relative h-2 rounded-full" aria-hidden>
        {value > 0 ? (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${barBg}`}
            style={{ width: `${terminal ? 100 : pct}%`, opacity: terminal ? 0.7 : 1 }}
          />
        ) : null}
      </div>
    </li>
  );
}
