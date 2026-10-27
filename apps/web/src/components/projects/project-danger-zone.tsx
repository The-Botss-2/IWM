'use client';

import { Archive, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProjectWithCreator } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { ConfirmByTypingDialog, ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDeleteProject, useUpdateProject } from '@/hooks/use-projects';
import { toast } from '@/lib/toast';

export function ProjectDangerZone({ project }: { project: ProjectWithCreator }) {
  const router = useRouter();
  const update = useUpdateProject(project.id);
  const remove = useDeleteProject();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const archived = project.status === 'ARCHIVED';

  return (
    <section
      aria-labelledby="danger-heading"
      className="rounded-lg border-2 border-state-error/30 bg-state-error/10 p-5"
    >
      <h2 id="danger-heading" className="text-base font-semibold text-state-error">
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-state-error">
        These actions are not reversible from the UI. Proceed carefully.
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex flex-col gap-3 rounded-md border border-state-error/30 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-ink">
              {archived ? 'Project archived' : 'Archive project'}
            </div>
            <div className="text-sm text-ink-muted">
              {archived
                ? 'It will no longer appear in active lists. You can change the status back any time.'
                : 'Hide this project from active lists. Members keep access.'}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setArchiveOpen(true)}
            disabled={archived || update.isPending}
            className="sm:shrink-0"
          >
            <Archive className="h-4 w-4" />
            {archived ? 'Archived' : 'Archive'}
          </Button>
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-state-error/30 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-ink">Delete project</div>
            <div className="text-sm text-ink-muted">
              Soft-deletes the project and all its tasks. Recovery requires admin tools.
            </div>
          </div>
          <Button
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            disabled={remove.isPending}
            className="sm:shrink-0"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this project?"
        description="The project will move out of active views. You can unarchive at any time by changing the status."
        confirmLabel="Archive project"
        variant="destructive"
        pending={update.isPending}
        onConfirm={async () => {
          await update.mutateAsync({ status: 'ARCHIVED' });
          setArchiveOpen(false);
          toast.success('Project archived.');
        }}
      />

      <ConfirmByTypingDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this project?"
        description={`This action will soft-delete ${project.name}. Type the project key to confirm.`}
        challenge={project.key}
        challengeLabel="Type the project key"
        confirmLabel="Delete project"
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync(project.id);
          setDeleteOpen(false);
          toast.success('Project deleted.');
          router.push('/projects');
        }}
      />
    </section>
  );
}
