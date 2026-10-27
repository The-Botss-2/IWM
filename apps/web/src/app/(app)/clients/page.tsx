'use client';

import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ClientStatusBadge } from '@/components/clients/client-badges';
import { ClientFormDialog } from '@/components/clients/client-form-dialog';
import { Button } from '@/components/ui/button';
import { Loader, PageLoader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Can } from '@/lib/ability';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useClients, useDeleteClient } from '@/hooks/use-clients';
import { useRequireSalesAccess } from '@/hooks/use-require-sales-access';
import { toast } from '@/lib/toast';

export default function ClientsPage() {
  // Open to the sales roles and workspace admins, plus anyone with a client
  // assigned to them (who sees only their own). Server enforces the same rule
  // and filters the rows - this is the client-side redirect.
  const access = useRequireSalesAccess('clients');
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  const [search, setSearch] = useState('');
  // Server-side search: the /clients list endpoint filters by name/email/
  // legalName, so we pass the (debounced) term through to the query rather
  // than filtering only the current page client-side.
  const debouncedSearch = useDebouncedValue(search, 250);
  const clients = useClients({
    pageSize: 50,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  });
  const remove = useDeleteClient();
  const emptyLabel = debouncedSearch.trim()
    ? 'No clients match your search.'
    : 'No clients yet.';

  if (!access.allowed) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <PageLoader label={access.checking ? 'Loading' : 'Redirecting'} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-ink-muted">
            <span className="hover:underline cursor-pointer">Dashboard</span>
            <span className="mx-1">›</span>
            <span className="underline">Clients</span>
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">Clients</h1>
          <p className="text-sm text-ink-muted">Customers and prospects.</p>
        </div>
        <Can I="create" a="Client">
          <Button onClick={() => setDialog(true)}>
            <Plus className="h-4 w-4" />
            New client
          </Button>
        </Can>
      </header>

      <div className="relative max-w-sm">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients…"
          aria-label="Search clients"
          className="input h-9 w-full pl-8 text-sm"
        />
      </div>

      {/* Mobile: stacked card list (below md). Renders from the same data array. */}
      <div className="space-y-3 md:hidden">
        {clients.isLoading ? (
          <div className="rounded-xl bg-white p-6 text-center shadow-soft">
            <Loader size="sm" label="Loading" />
          </div>
        ) : clients.isError && !clients.data ? (
          <QueryError
            message="Couldn't load clients."
            onRetry={() => void clients.refetch()}
          />
        ) : clients.data?.items.length ? (
          clients.data.items.map((c) => (
            <div
              key={c.id}
              onClick={() => router.push(`/clients/${c.id}`)}
              className="cursor-pointer rounded-xl bg-white p-4 shadow-soft transition-colors hover:bg-bg-subtle focus-within:bg-bg-subtle"
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/clients/${c.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-base font-medium text-ink hover:text-brand-purple focus-visible:outline-none focus-visible:text-brand-purple"
                >
                  {c.name}
                </Link>
                <ClientStatusBadge status={c.status} />
              </div>

              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Email
                  </dt>
                  <dd className="min-w-0 truncate text-right">
                    {c.email ? (
                      <a
                        href={`mailto:${c.email}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-brand-gradient hover:underline underline-offset-2"
                      >
                        {c.email}
                      </a>
                    ) : (
                      <span className="text-ink-muted">-</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Industry
                  </dt>
                  <dd className="text-ink">
                    {c.industry ?? <span className="text-ink-muted">-</span>}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Owner
                  </dt>
                  <dd className="text-ink">
                    {c.owner?.name ?? <span className="text-ink-muted">-</span>}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Assignee
                  </dt>
                  <dd className="text-ink">
                    {c.assignee?.name ?? <span className="text-ink-muted">Unassigned</span>}
                  </dd>
                </div>
              </dl>

              <div
                className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3"
                onClick={(e) => e.stopPropagation()}
              >
                <Link
                  href={`/clients/${c.id}`}
                  aria-label={`Edit ${c.name}`}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-all hover:bg-bg-subtle hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </Link>
                <Can I="delete" a="Client">
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => remove.mutate(c.id, { onSuccess: () => toast.success('Client deleted.') })}
                    className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-all hover:bg-tint-error hover:text-state-error focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </Can>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-xl bg-white p-6 text-center text-sm text-ink-muted shadow-soft">
            {emptyLabel}
          </div>
        )}
      </div>

      {/* Desktop: unchanged table (md and up). */}
      <div className="hidden md:block rounded-xl bg-white p-4 sm:p-6 shadow-soft overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Industry</Th>
              <Th>Status</Th>
              <Th>Owner</Th>
              <Th>Assignee</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {clients.isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center">
                  <Loader size="sm" label="Loading" />
                </td>
              </tr>
            ) : clients.isError && !clients.data ? (
              <tr>
                <td colSpan={7} className="px-4 py-6">
                  <QueryError
                    message="Couldn't load clients."
                    onRetry={() => void clients.refetch()}
                  />
                </td>
              </tr>
            ) : clients.data?.items.length ? (
              clients.data.items.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/clients/${c.id}`)}
                  className="cursor-pointer border-t border-line transition-colors hover:bg-bg-subtle focus-within:bg-bg-subtle"
                >
                  <Td className="font-medium">
                    <Link
                      href={`/clients/${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-ink hover:text-brand-purple focus-visible:outline-none focus-visible:text-brand-purple"
                    >
                      {c.name}
                    </Link>
                  </Td>
                  <Td>
                    {c.email ? (
                      <a
                        href={`mailto:${c.email}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-brand-gradient hover:underline underline-offset-2"
                      >
                        {c.email}
                      </a>
                    ) : (
                      <span className="text-ink-muted">-</span>
                    )}
                  </Td>
                  <Td>{c.industry ?? <span className="text-ink-muted">-</span>}</Td>
                  <Td>
                    <ClientStatusBadge status={c.status} />
                  </Td>
                  <Td>{c.owner?.name ?? <span className="text-ink-muted">-</span>}</Td>
                  <Td>
                    {c.assignee?.name ?? <span className="text-ink-muted">Unassigned</span>}
                  </Td>
                  <Td>
                    <div
                      className="flex items-center justify-end gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link
                        href={`/clients/${c.id}`}
                        aria-label={`Edit ${c.name}`}
                        className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-all hover:bg-bg-subtle hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                      <Can I="delete" a="Client">
                        <button
                          type="button"
                          aria-label={`Delete ${c.name}`}
                          onClick={() => remove.mutate(c.id, { onSuccess: () => toast.success('Client deleted.') })}
                          className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-all hover:bg-tint-error hover:text-state-error focus-visible:outline-none focus-visible:shadow-focus"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </Can>
                    </div>
                  </Td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-muted">
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dialog ? <ClientFormDialog onClose={() => setDialog(false)} /> : null}
    </div>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
    {children}
  </th>
);
const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <td className={`px-4 py-3 text-ink ${className}`}>{children}</td>
);
