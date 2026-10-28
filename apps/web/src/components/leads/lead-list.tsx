'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { LeadWithOwner } from '@botss/shared-types';

import { SourceBadge, StageBadge } from '@/components/leads/lead-badges';
import { formatCurrency } from '@/lib/money';
import { UserAvatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { useIsSmall } from '@/hooks/use-media-query';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

type SortKey = 'name' | 'company' | 'stage' | 'estimatedValue' | 'updatedAt';

const ROW_HEIGHT = 56;
const VIRTUALIZATION_THRESHOLD = 50;

interface Props {
  leads: LeadWithOwner[];
  isLoading: boolean;
  hasFilters: boolean;
  onSelect: (leadId: string) => void;
}

export function LeadList({ leads, isLoading, hasFilters, onSelect }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'updatedAt',
    dir: 'desc',
  });

  const sorted = useMemo(() => {
    const arr = [...leads];
    const dir = sort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'company':
          return (a.company ?? '').localeCompare(b.company ?? '') * dir;
        case 'stage':
          return a.stage.localeCompare(b.stage) * dir;
        case 'estimatedValue': {
          const av = a.estimatedValue ? Number(a.estimatedValue) : 0;
          const bv = b.estimatedValue ? Number(b.estimatedValue) : 0;
          return (av - bv) * dir;
        }
        case 'updatedAt':
          return (a.updatedAt.getTime() - b.updatedAt.getTime()) * dir;
        default:
          return 0;
      }
    });
    return arr;
  }, [leads, sort]);

  const onSortClick = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="border-line rounded-lg border border-dashed bg-white p-10 text-center">
        <p className="text-ink text-sm font-medium">
          {hasFilters ? 'No leads match these filters.' : 'No leads yet.'}
        </p>
        <p className="text-ink-muted mt-1 text-sm">
          {hasFilters
            ? 'Try removing a filter or clearing the search.'
            : 'Capture your first opportunity with the New lead button.'}
        </p>
      </div>
    );
  }

  return <Table leads={sorted} sort={sort} onSortClick={onSortClick} onSelect={onSelect} />;
}

function Table({
  leads,
  sort,
  onSortClick,
  onSelect,
}: {
  leads: LeadWithOwner[];
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSortClick: (k: SortKey) => void;
  onSelect: (id: string) => void;
}) {
  const isSmall = useIsSmall();

  if (isSmall) {
    return (
      <ul className="divide-line border-line divide-y rounded-lg border bg-white">
        {leads.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onSelect(l.id)}
              className="hover:bg-bg-subtle focus-visible:bg-bg-subtle flex w-full flex-col gap-2 p-3 text-left focus-visible:outline-none"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-ink truncate text-sm font-medium">{l.name}</span>
                <StageBadge stage={l.stage} />
              </div>
              {l.company ? (
                <span className="text-ink-muted truncate text-xs">{l.company}</span>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <SourceBadge source={l.source} />
                <span className="text-ink text-xs font-medium">
                  {l.estimatedValue
                    ? formatCurrency(l.estimatedValue, l.currency, { compact: true })
                    : '-'}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="border-line overflow-x-auto rounded-lg border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-bg-subtle text-ink-muted sticky top-0 z-10 text-left text-xs font-medium uppercase tracking-wide">
          <tr>
            <SortHeader label="Name" sortKey="name" sort={sort} onClick={onSortClick} />
            <SortHeader label="Company" sortKey="company" sort={sort} onClick={onSortClick} />
            <SortHeader label="Stage" sortKey="stage" sort={sort} onClick={onSortClick} />
            <th className="px-3 py-2">Source</th>
            <SortHeader label="Value" sortKey="estimatedValue" sort={sort} onClick={onSortClick} />
            <th className="px-3 py-2">Owner</th>
            <th className="px-3 py-2">Assignee</th>
            <SortHeader label="Updated" sortKey="updatedAt" sort={sort} onClick={onSortClick} />
          </tr>
        </thead>
        {leads.length > VIRTUALIZATION_THRESHOLD ? (
          <VirtualTbody leads={leads} onSelect={onSelect} />
        ) : (
          <tbody>
            {leads.map((l) => (
              <Row key={l.id} lead={l} onSelect={() => onSelect(l.id)} />
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function VirtualTbody({
  leads,
  onSelect,
}: {
  leads: LeadWithOwner[];
  onSelect: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: leads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  return (
    <tbody>
      <tr>
        <td colSpan={8} className="p-0">
          <div ref={parentRef} className="max-h-[640px] overflow-auto">
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              role="rowgroup"
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const l = leads[vi.index];
                if (!l) return null;
                return (
                  <VirtualRow key={l.id} lead={l} top={vi.start} onSelect={() => onSelect(l.id)} />
                );
              })}
            </div>
          </div>
        </td>
      </tr>
    </tbody>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onClick,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onClick: (k: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      className="px-3 py-2"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className="text-ink-muted hover:text-ink focus-visible:text-ink flex items-center gap-1 text-xs uppercase tracking-wide focus-visible:outline-none"
      >
        {label}
        <Icon className={cn('h-3 w-3', active ? 'text-ink' : 'text-ink-disabled')} aria-hidden />
      </button>
    </th>
  );
}

function Row({ lead, onSelect }: { lead: LeadWithOwner; onSelect: () => void }) {
  return (
    <tr className="border-line hover:bg-bg-subtle border-t">
      <td className="px-3 py-2 align-middle">
        <button
          type="button"
          onClick={onSelect}
          className="text-ink hover:text-brand-700 focus-visible:text-brand-700 text-left text-sm font-medium focus-visible:outline-none"
        >
          {lead.name}
        </button>
      </td>
      <td className="text-ink px-3 py-2 align-middle text-sm">{lead.company ?? '-'}</td>
      <td className="px-3 py-2 align-middle">
        <StageBadge stage={lead.stage} />
      </td>
      <td className="px-3 py-2 align-middle">
        <SourceBadge source={lead.source} />
      </td>
      <td className="text-ink px-3 py-2 align-middle text-sm">
        {lead.estimatedValue
          ? formatCurrency(lead.estimatedValue, lead.currency, { compact: true })
          : '-'}
      </td>
      <td className="px-3 py-2 align-middle">
        <PersonCell user={lead.owner} emptyLabel="Unknown" />
      </td>
      <td className="px-3 py-2 align-middle">
        <PersonCell user={lead.assignee} emptyLabel="Unassigned" />
      </td>
      <td className="text-ink-muted px-3 py-2 align-middle text-xs">
        <Tooltip content={lead.updatedAt.toString()}>
          <span>{relativeTime(lead.updatedAt)}</span>
        </Tooltip>
      </td>
    </tr>
  );
}

function VirtualRow({
  lead,
  top,
  onSelect,
}: {
  lead: LeadWithOwner;
  top: number;
  onSelect: () => void;
}) {
  return (
    <div
      role="row"
      className="border-line hover:bg-bg-subtle absolute left-0 right-0 grid items-center gap-2 border-t px-3"
      style={{
        transform: `translateY(${top}px)`,
        // Mirrors the <thead> column order: name, company, stage, source,
        // value, owner, assignee, updated.
        gridTemplateColumns:
          'minmax(0, 1.6fr) minmax(0, 1.2fr) 140px 140px 120px minmax(0, 160px) minmax(0, 160px) 110px',
        height: ROW_HEIGHT,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="text-ink hover:text-brand-700 focus-visible:text-brand-700 truncate text-left text-sm font-medium focus-visible:outline-none"
      >
        {lead.name}
      </button>
      <span className="text-ink truncate text-sm">{lead.company ?? '-'}</span>
      <StageBadge stage={lead.stage} />
      <SourceBadge source={lead.source} />
      <span className="text-ink truncate text-sm">
        {lead.estimatedValue
          ? formatCurrency(lead.estimatedValue, lead.currency, { compact: true })
          : '-'}
      </span>
      <PersonCell user={lead.owner} emptyLabel="Unknown" />
      <PersonCell user={lead.assignee} emptyLabel="Unassigned" />
      <span className="text-ink-muted truncate text-xs">{relativeTime(lead.updatedAt)}</span>
    </div>
  );
}

/** Avatar + name for either of the two people on a lead (owner or assignee). */
function PersonCell({ user, emptyLabel }: { user: LeadWithOwner['owner']; emptyLabel: string }) {
  if (!user) return <span className="text-ink-disabled text-xs">{emptyLabel}</span>;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <UserAvatar size="sm" name={user.name || user.email} image={user.image} />
      <span className="text-ink truncate text-sm">{user.name || user.email}</span>
    </div>
  );
}
