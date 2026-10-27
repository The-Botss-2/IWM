'use client';

import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CreateTaskFormInput, TaskFormField } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreateTaskForm,
  useDeleteTaskForm,
  useTaskForms,
  useUpdateTaskForm,
} from '@/hooks/use-task-forms';
import { toast, toastError } from '@/lib/toast';

export default function FormsView({ projectId }: { projectId: string }) {
  const forms = useTaskForms(projectId);
  const create = useCreateTaskForm(projectId);
  const update = useUpdateTaskForm(projectId);
  const remove = useDeleteTaskForm(projectId);
  const [newOpen, setNewOpen] = useState(false);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          Public intake forms create tasks in this project. Rate-limited to 10 / hour / IP.
        </p>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" /> New form
        </Button>
      </div>

      {forms.isLoading ? (
        <Skeleton className="h-32" />
      ) : forms.isError && !forms.data ? (
        <QueryError message="Couldn't load forms." onRetry={() => void forms.refetch()} />
      ) : forms.data && forms.data.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {forms.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-medium text-ink">{f.name}</h4>
                  {f.isPublic ? <Badge tone="brand">Public</Badge> : <Badge tone="neutral">Private</Badge>}
                </div>
                {f.description ? (
                  <p className="text-xs text-ink-muted">{f.description}</p>
                ) : null}
                <p className="text-xs text-ink-muted">
                  {f.fields.length} field{f.fields.length === 1 ? '' : 's'} · default{' '}
                  {f.defaultStatus.toLowerCase()}
                </p>
              </div>
              {f.isPublic && f.publicSlug ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const url = `${window.location.origin}/forms/${f.publicSlug}`;
                    navigator.clipboard.writeText(url).then(
                      () => toast.success('Public form URL copied.'),
                      (err: unknown) => toastError(err, "Couldn't copy link"),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" /> Copy link
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update.mutate(
                      { id: f.id, input: { isPublic: true } },
                      { onSuccess: () => toast.success(`Form "${f.name}" published.`) },
                    )
                  }
                >
                  Publish
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete form ${f.name}`}
                onClick={() => {
                  if (confirm(`Delete form "${f.name}"?`)) remove.mutate(f.id);
                }}
              >
                <Trash2 className="h-4 w-4 text-ink-muted" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
          No forms yet. Create one to let people outside the workspace submit tasks.
        </div>
      )}

      <NewFormDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        pending={create.isPending}
        onSubmit={async (input) => {
          try {
            await create.mutateAsync(input);
            toast.success(`Form "${input.name}" created.`);
            setNewOpen(false);
          } catch {
            /* hook surfaces toast */
          }
        }}
      />
    </section>
  );
}

const SIMPLE_FIELDS: TaskFormField[] = [
  { id: 'title', label: 'Title', type: 'text', required: true },
  { id: 'details', label: 'Details', type: 'textarea', required: false },
];

function NewFormDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  pending: boolean;
  onSubmit: (input: CreateTaskFormInput) => void;
}) {
  const [name, setName] = useState('Bug report');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [fields, setFields] = useState<TaskFormField[]>(SIMPLE_FIELDS);

  function addField(type: TaskFormField['type']) {
    const id = `field_${fields.length + 1}`;
    setFields((prev) => [
      ...prev,
      { id, label: `New ${type} field`, type, required: false },
    ]);
  }
  function removeField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
  }
  function patchField(id: string, patch: Partial<TaskFormField>) {
    setFields((prev) =>
      prev.map((f) =>
        f.id === id ? ({ ...f, ...patch } as TaskFormField) : f,
      ),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New form</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="public"
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <Label htmlFor="public">Publish a public submission URL</Label>
          </div>

          <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium uppercase tracking-wide text-ink-muted">Fields</h4>
              <select
                defaultValue=""
                className="rounded border border-line px-2 py-1 text-xs"
                onChange={(e) => {
                  if (e.target.value) addField(e.target.value as TaskFormField['type']);
                  e.currentTarget.value = '';
                }}
              >
                <option value="">Add field…</option>
                <option value="text">Text</option>
                <option value="textarea">Textarea</option>
                <option value="email">Email</option>
                <option value="number">Number</option>
                <option value="select">Select</option>
                <option value="checkbox">Checkbox</option>
              </select>
            </div>
            <ul className="space-y-2">
              {fields.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <Input
                    aria-label={`Label for field ${f.id}`}
                    value={f.label}
                    onChange={(e) => patchField(f.id, { label: e.target.value })}
                    className="flex-1"
                  />
                  <span className="rounded-md bg-bg-subtle px-2 py-1 text-xs text-ink-muted">
                    {f.type}
                  </span>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => patchField(f.id, { required: e.target.checked })}
                    />
                    required
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove field ${f.label}`}
                    onClick={() => removeField(f.id)}
                  >
                    <Trash2 className="h-4 w-4 text-ink-muted" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || fields.length === 0 || !name.trim()}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || undefined,
                fields,
                defaultStatus: 'BACKLOG',
                defaultPriority: 'MEDIUM',
                isPublic,
              })
            }
          >
            {pending ? 'Creating…' : 'Create form'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
