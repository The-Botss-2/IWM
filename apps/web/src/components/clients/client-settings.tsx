'use client';

import { Archive, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ClientDetail } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { ConfirmByTypingDialog, ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDeleteClient, useUpdateClient } from '@/hooks/use-clients';
import { toast } from '@/lib/toast';

export function ClientSettings({ client }: { client: ClientDetail }) {
  const router = useRouter();
  const update = useUpdateClient();
  const remove = useDeleteClient();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const paused = client.status === 'PAUSED';

  return (
    <section
      aria-labelledby="client-danger-heading"
      className="rounded-lg border-2 border-state-error/30 bg-state-error/10 p-5"
    >
      <h2 id="client-danger-heading" className="text-base font-semibold text-state-error">
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-state-error">
        These actions affect everything tied to this client. Proceed carefully.
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex flex-col gap-3 rounded-md border border-state-error/30 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-ink">
              {paused ? 'Client paused' : 'Archive client'}
            </div>
            <div className="text-sm text-ink-muted">
              {paused
                ? 'The client is paused. Change the status from the Overview tab to reactivate.'
                : 'Marks the client as paused. They remain visible but drop out of active queues.'}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setArchiveOpen(true)}
            disabled={paused || update.isPending}
            className="sm:shrink-0"
          >
            <Archive className="h-4 w-4" />
            {paused ? 'Paused' : 'Archive'}
          </Button>
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-state-error/30 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-ink">Delete client</div>
            <div className="text-sm text-ink-muted">
              Soft-deletes the client. Linked projects keep working but lose their client reference.
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
        title="Archive this client?"
        description="The client's status will be set to Paused. You can switch it back from the Overview tab."
        confirmLabel="Archive client"
        variant="destructive"
        pending={update.isPending}
        onConfirm={async () => {
          await update.mutateAsync({ id: client.id, input: { status: 'PAUSED' } });
          setArchiveOpen(false);
          toast.success('Client archived.');
        }}
      />

      <ConfirmByTypingDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this client?"
        description={`This action soft-deletes ${client.name}. Type the client's name to confirm.`}
        challenge={client.name}
        challengeLabel="Type the client name"
        confirmLabel="Delete client"
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync(client.id);
          setDeleteOpen(false);
          toast.success('Client deleted.');
          router.push('/clients');
        }}
      />
    </section>
  );
}
