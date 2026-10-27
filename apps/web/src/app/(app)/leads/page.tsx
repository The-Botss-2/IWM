'use client';

import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { LeadSource, LeadStage } from '@botss/shared-types';

import { LeadDetailPanel } from '@/components/leads/lead-detail-panel';
import {
  LeadFilterBar,
  type SourceFilter,
  type StageFilter,
} from '@/components/leads/lead-filter-bar';
import { LeadFormDialog } from '@/components/leads/lead-form-dialog';
import { LeadList } from '@/components/leads/lead-list';
import { LeadPipeline } from '@/components/leads/lead-pipeline';
import { LeadViewTabs, useLeadView } from '@/components/leads/lead-view-tabs';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useLeads } from '@/hooks/use-leads';
import { useRequireSalesAccess } from '@/hooks/use-require-sales-access';
import { Can } from '@/lib/ability';

export default function LeadsPage() {
  // Open to the sales roles and workspace admins, plus anyone with a lead
  // assigned to them (who sees only their own). Server enforces the same rule
  // and filters the rows - this is the client-side redirect.
  const access = useRequireSalesAccess('leads');
  const { view, setView } = useLeadView();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  // Single shared query - pipeline and list both subscribe to the same key, so
  // there's only one in-flight fetch even though both views may mount.
  const { data, isLoading, isError, refetch } = useLeads({ pageSize: 200 });
  const allLeads = useMemo(() => data?.items ?? [], [data]);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [stageFilter, setStageFilter] = useState<StageFilter>('ALL');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const filteredLeads = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    return allLeads.filter((l) => {
      if (stageFilter !== 'ALL' && l.stage !== (stageFilter as LeadStage)) return false;
      if (sourceFilter !== 'ALL' && l.source !== (sourceFilter as LeadSource)) return false;
      if (assigneeFilter && l.assigneeId !== assigneeFilter) return false;
      if (needle) {
        const hay = `${l.name} ${l.company ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allLeads, debouncedSearch, stageFilter, sourceFilter, assigneeFilter]);

  const selectedLead = useMemo(
    () => allLeads.find((l) => l.id === selectedLeadId) ?? null,
    [allLeads, selectedLeadId],
  );

  const hasFilters =
    debouncedSearch.length > 0 ||
    stageFilter !== 'ALL' ||
    sourceFilter !== 'ALL' ||
    !!assigneeFilter;

  if (!access.allowed) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <PageLoader label={access.checking ? 'Loading' : 'Redirecting'} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-ink-muted">
            <span className="hover:underline cursor-pointer">Dashboard</span>
            <span className="mx-1">›</span>
            <span className="underline">Leads</span>
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">Leads</h1>
          <p className="text-sm text-ink-muted">Pipeline of opportunities.</p>
        </div>
        <Can I="create" a="Lead">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New lead
          </Button>
        </Can>
      </header>

      <LeadViewTabs view={view} onChange={setView} />

      <LeadFilterBar
        search={search}
        onSearchChange={setSearch}
        stage={stageFilter}
        onStageChange={setStageFilter}
        source={sourceFilter}
        onSourceChange={setSourceFilter}
        assigneeId={assigneeFilter}
        onAssigneeChange={setAssigneeFilter}
      />

      <div role="region" aria-label={`${view} view`}>
        {isError && !data ? (
          <QueryError
            message="Couldn't load leads."
            onRetry={() => void refetch()}
          />
        ) : view === 'pipeline' ? (
          <LeadPipeline
            leads={filteredLeads}
            isLoading={isLoading}
            onSelect={setSelectedLeadId}
          />
        ) : (
          <LeadList
            leads={filteredLeads}
            isLoading={isLoading}
            hasFilters={hasFilters}
            onSelect={setSelectedLeadId}
          />
        )}
      </div>

      <LeadDetailPanel lead={selectedLead} onClose={() => setSelectedLeadId(null)} />

      <LeadFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
