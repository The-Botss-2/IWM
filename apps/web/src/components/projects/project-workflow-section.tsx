'use client';

import { useState } from 'react';
import type { ProjectWithCreator, TaskStatus } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateProject } from '@/hooks/use-projects';
import { toast } from '@/lib/toast';

const STATUSES: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];

export function ProjectWorkflowSection({ project }: { project: ProjectWithCreator }) {
  const update = useUpdateProject(project.id);
  const initial = (project.workflowSettings?.wipLimits as Record<string, number> | undefined) ?? {};
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(STATUSES.map((s) => [s, initial[s]?.toString() ?? ''])),
  );

  async function save() {
    const wipLimits: Record<string, number> = {};
    for (const [s, v] of Object.entries(limits)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) wipLimits[s] = Math.floor(n);
    }
    try {
      await update.mutateAsync({ workflowSettings: { wipLimits } });
      toast.success('Workflow saved.');
    } catch {
      /* hook surfaces toast */
    }
  }

  return (
    <section className="border-line rounded-lg border bg-white p-5">
      <h2 className="text-ink text-base font-semibold">Workflow</h2>
      <p className="text-ink-muted mt-1 text-sm">
        WIP limit per status column. Leave blank for no limit. Columns over the limit show a red
        border on the board.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STATUSES.map((s) => (
          <div key={s} className="space-y-1.5">
            <Label className="text-ink-muted text-xs uppercase tracking-wide">{s}</Label>
            <Input
              type="number"
              min={1}
              value={limits[s]}
              onChange={(e) => setLimits((p) => ({ ...p, [s]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save workflow'}
        </Button>
      </div>
    </section>
  );
}
