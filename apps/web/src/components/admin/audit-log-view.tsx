'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  AuditLogEntry,
  AuditLogListResponse,
  ListAuditLogQuery,
} from '@botss/shared-types';

import { AuditLogTable } from '@/components/admin/audit-log-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useDebouncedValue } from '@/hooks/use-debounced';

/**
 * Searchable, paginated audit view shared by the organization's audit log
 * and the SUPER_ADMIN platform log. The caller picks the endpoint.
 */
export function AuditLogView<T extends AuditLogEntry>({
  title,
  description,
  queryKey,
  fetchPage,
  organizationName,
  actionPlaceholder,
  alertsFilter = false,
}: {
  title: string;
  description: string;
  queryKey: string;
  fetchPage: (
    query: Partial<ListAuditLogQuery>,
  ) => Promise<Omit<AuditLogListResponse, 'items'> & { items: T[] }>;
  organizationName?: (row: T) => string | null;
  actionPlaceholder: string;
  /** Show an "Alerts only" toggle (the platform log, which has security alerts). */
  alertsFilter?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  // Server-side search (the log paginates): the term spans action, target,
  // and actor name/email. Debounced so each keystroke isn't a round-trip.
  const debouncedSearch = useDebouncedValue(search, 300);

  const list = useQuery({
    queryKey: ['admin', queryKey, page, actionFilter, debouncedSearch, alertsOnly],
    queryFn: () =>
      fetchPage({
        page,
        pageSize: 50,
        ...(alertsFilter && alertsOnly ? { alertsOnly: 'true' as const } : {}),
        ...(actionFilter.trim() ? { action: actionFilter.trim() } : {}),
        ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      }),
    staleTime: 10_000,
  });

  const items = list.data?.items ?? [];
  const pagination = list.data?.pagination;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="audit-search" className="text-xs">
            Search
          </Label>
          <Input
            id="audit-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Actor or action…"
            className="w-64"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="action-filter" className="text-xs">
            Filter by action
          </Label>
          <Input
            id="action-filter"
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
            placeholder={actionPlaceholder}
            className="w-56"
          />
        </div>
        {alertsFilter ? (
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="alerts-only"
              checked={alertsOnly}
              onCheckedChange={(v) => {
                setAlertsOnly(v === true);
                setPage(1);
              }}
            />
            <Label htmlFor="alerts-only" className="text-xs">
              Alerts only
            </Label>
          </div>
        ) : null}
      </div>

      <section className="rounded-lg border border-line bg-white">
        <div className="overflow-x-auto">
          {list.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : list.isError && !list.data ? (
            <QueryError
              message="Couldn't load the audit log."
              onRetry={() => void list.refetch()}
              className="m-4"
            />
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              No matching events.
            </p>
          ) : (
            <AuditLogTable
              items={items}
              {...(organizationName ? { organizationName } : {})}
            />
          )}
        </div>
      </section>

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-ink-muted">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={pagination.page <= 1 || list.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pagination.page >= pagination.totalPages || list.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
