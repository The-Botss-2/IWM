'use client';

import { WorkspaceInfoForm } from '@/components/workspace/workspace-info-form';
import { WorkspaceMembersSection } from '@/components/workspace/workspace-members-section';
import { WorkspaceProjectAccessSection } from '@/components/workspace/workspace-project-access-section';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentWorkspace } from '@/hooks/use-workspace';

export default function WorkspaceSettingsPage() {
  const workspace = useCurrentWorkspace();

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-ink text-lg font-semibold">Workspace</h2>
        <p className="text-ink-muted text-sm">
          Manage workspace info, members, and pending invitations.
        </p>
      </header>

      {workspace.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-64" />
        </div>
      ) : workspace.isError || !workspace.data ? (
        <div className="text-state-error text-sm">Couldn&apos;t load workspace.</div>
      ) : (
        <>
          <WorkspaceInfoForm workspace={workspace.data} />
          <WorkspaceMembersSection />
          {/* Renders nothing for non-admins - see the component. */}
          <WorkspaceProjectAccessSection workspace={workspace.data} />
        </>
      )}
    </div>
  );
}
