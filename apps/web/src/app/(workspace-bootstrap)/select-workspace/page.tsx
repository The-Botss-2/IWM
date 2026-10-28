'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { CreateWorkspaceInput } from '@botss/shared-types';

import { Logo } from '@/components/branding/logo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { getApi } from '@/lib/api';
import { unregisterNativePush } from '@/hooks/use-native-push';
import { useWorkspaces } from '@/hooks/use-workspace';
import { clearAppAppearance } from '@/lib/app-prefs';
import { authClient } from '@/lib/auth-client';
import { clearAllInAppNotifications } from '@/lib/in-app-notifications';
import { sessionQueryOptions } from '@/lib/session-query';
import { toastErrorMessage } from '@/lib/toast';
import { writeWorkspaceCookie } from '@/lib/workspace-cookie';
import { getSupportSession, writeSupportWorkspace } from '@/lib/support-session';

/**
 * Workspace picker shown when a user has more than one membership, or when
 * they want to swap the active tenant. Single-membership users skip this
 * page automatically - the API's AuthGuard auto-bootstraps a personal
 * workspace for first-time sign-ins, so almost everyone starts with exactly
 * one and never sees this UI on the happy path.
 */
export default function SelectWorkspacePage() {
  const router = useRouter();
  const qc = useQueryClient();

  const session = useQuery(sessionQueryOptions);
  // Client-portal accounts have no workspaces; send them to their portal.
  const isPortalAccount = session.data?.user.accountType === 'CLIENT';
  useEffect(() => {
    if (isPortalAccount) router.replace('/portal');
  }, [isPortalAccount, router]);

  const workspaces = useWorkspaces({
    enabled: !!session.data && !isPortalAccount,
    staleTime: 0,
  });

  const [createOpen, setCreateOpen] = useState(false);

  const continueWith = (workspaceId: string) => {
    // A read only support session keeps its workspace in this tab only, so
    // the operator's own tabs keep their workspace cookie.
    if (getSupportSession()) writeSupportWorkspace(workspaceId);
    else writeWorkspaceCookie(workspaceId);
    // Reset cached queries that were scoped to the previous workspace - every
    // 'tasks', 'documents', 'projects', etc. cache key is now stale.
    qc.clear();
    // Land on the workspace hub (Projects · Clients · Leads · Documents)
    // rather than the global home, so the user immediately sees the four
    // tenant-scoped surfaces they just chose this workspace for.
    router.replace('/workspace');
  };

  const signOut = async () => {
    // A plain link to /sign-in used to sit here labelled "Sign out", which
    // left the session alive; the next visit signed the user straight back in.
    await unregisterNativePush().catch(() => undefined);
    await authClient.signOut().catch(() => undefined);
    qc.clear();
    clearAllInAppNotifications();
    clearAppAppearance();
    router.replace('/sign-in');
    router.refresh();
  };

  const memberships = session.data?.workspaceMemberships ?? [];
  const items = workspaces.data?.items ?? [];

  // A client-portal account is on its way to /portal; never flash the
  // workspace picker (its create buttons would only 403) in the meantime.
  if (isPortalAccount) {
    return <PageLoader fullScreen label="Opening your client portal" />;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Logo variant="full" size="md" />
      </div>

      <header className="mb-6 text-center">
        <h1 className="text-ink text-2xl font-semibold">Pick a workspace</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Choose which workspace to open. You can switch later from the sidebar.
        </p>
      </header>

      {session.isLoading || workspaces.isLoading ? (
        <div className="border-line bg-bg-surface rounded-md border">
          <PageLoader label="Loading workspaces" className="min-h-[12rem]" />
        </div>
      ) : workspaces.isError && !workspaces.data ? (
        <QueryError message="Couldn't load workspaces." onRetry={() => void workspaces.refetch()} />
      ) : items.length === 0 ? (
        <div className="border-line-strong bg-bg-surface rounded-md border border-dashed p-8 text-center">
          <p className="text-ink-muted text-sm">You aren&apos;t a member of any workspace yet.</p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            Create your first workspace
          </Button>
        </div>
      ) : (
        <ul className="space-y-2" role="list">
          {items.map((ws) => {
            const membership = memberships.find((m) => m.workspaceId === ws.id);
            return (
              <li key={ws.id}>
                <button
                  type="button"
                  onClick={() => continueWith(ws.id)}
                  className="border-line bg-bg-surface hover:border-brand-purple/40 hover:bg-brand-50/40 focus-visible:shadow-focus flex w-full items-center gap-4 rounded-md border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2"
                >
                  <div className="bg-brand-50 text-brand-700 grid h-10 w-10 shrink-0 place-items-center rounded-md text-sm font-bold">
                    {(ws.name?.[0] ?? '?').toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink truncate text-sm font-semibold">{ws.name}</div>
                    <div className="text-ink-muted truncate text-xs">
                      /{ws.slug}
                      {membership ? ` · ${membership.role.toLowerCase()}` : null}
                    </div>
                  </div>
                  <span className="text-brand-700 text-xs font-medium">Open →</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <Button variant="ghost" onClick={() => setCreateOpen(true)}>
          + Create workspace
        </Button>
        <div className="text-ink-muted flex items-center gap-4 text-xs">
          <Link href="/settings/workspace" className="hover:text-ink">
            Workspace settings
          </Link>
          <button type="button" onClick={() => void signOut()} className="hover:text-ink">
            Sign out
          </button>
        </div>
      </div>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          setCreateOpen(false);
          continueWith(id);
        }}
      />
    </main>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreated: (workspaceId: string) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  const create = useMutation({
    meta: { errorTitle: "Couldn't create workspace" },
    mutationFn: (input: CreateWorkspaceInput) => getApi().workspaces.create(input),
    onSuccess: (ws) => {
      onCreated(ws.id);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmedName = name.trim();
            const trimmedSlug = slug.trim().toLowerCase();
            if (!trimmedName || !trimmedSlug) {
              toastErrorMessage('Name and slug are required');
              return;
            }
            create.mutate({ name: trimmedName, slug: trimmedSlug });
          }}
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">Workspace name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-slug">Slug</Label>
            <Input
              id="ws-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.replace(/[^a-z0-9-]+/gi, '-').toLowerCase())}
              placeholder="acme"
            />
            <p className="text-ink-muted text-xs">
              Used in URLs. Letters, numbers, and dashes only.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
