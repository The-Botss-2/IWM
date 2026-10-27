'use client';

import { useQuery } from '@tanstack/react-query';
import { Briefcase, ExternalLink, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { getApi } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/time';

/**
 * Tenant admin "Workspaces" panel. Lists every workspace inside the
 * actor's organization - which after the org-scope expansion means
 * every workspace they have implicit read access to. Tenant admins
 * use this as their bird's-eye view; global admins (root-org ADMIN)
 * see the same list scoped to their root org and otherwise use
 * /admin/organizations to act across tenants.
 */
export default function AdminWorkspacesPage() {
  const list = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () => getApi().workspaces.list({ page: 1, pageSize: 100 }),
    staleTime: 30_000,
  });

  const [search, setSearch] = useState('');
  // pageSize:100 loads the whole list, so filter client-side by name/slug.
  const filtered = useMemo(() => {
    const all = list.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (ws) =>
        ws.name.toLowerCase().includes(q) || ws.slug.toLowerCase().includes(q),
    );
  }, [list.data, search]);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-ink">Workspaces</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Every workspace inside your organization. Members and per-workspace
          settings live on each workspace page.
        </p>
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
          placeholder="Search workspaces…"
          aria-label="Search workspaces"
          className="input h-9 w-full pl-8 text-sm"
        />
      </div>

      <section className="rounded-lg border border-line bg-white">
        <div className="overflow-x-auto">
          {list.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : list.isError && !list.data ? (
            <div className="p-4">
              <QueryError
                message="Couldn't load workspaces."
                onRetry={() => void list.refetch()}
              />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {search.trim() ? 'No workspaces match your search.' : 'No workspaces yet.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Slug</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">Updated</th>
                  <th className="px-4 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ws) => (
                  <tr key={ws.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Briefcase className="h-4 w-4 text-ink-muted" />
                        <span className="font-medium text-ink">{ws.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                      {ws.slug}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">
                      <span title={absoluteTime(ws.createdAt)}>
                        {relativeTime(ws.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">
                      <span title={absoluteTime(ws.updatedAt)}>
                        {relativeTime(ws.updatedAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                        className="text-ink-muted hover:text-ink"
                      >
                        <Link href="/settings/workspace">
                          <ExternalLink className="h-3.5 w-3.5" />
                          Settings
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
