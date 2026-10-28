'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldScope,
  CustomFieldType,
} from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateCustomFieldDefinition,
  useCustomFieldDefinitions,
  useDeleteCustomFieldDefinition,
  useUpdateCustomFieldDefinition,
} from '@/hooks/use-custom-fields';
import { useProjects } from '@/hooks/use-projects';

// Task fields belong to one project: they show in that project's task panel
// and as optional List view columns.

const SCOPES: CustomFieldScope[] = ['TASK', 'PROJECT', 'LEAD', 'CLIENT'];
const TYPES: CustomFieldType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
  'URL',
  'USER',
];

export default function CustomFieldsPage() {
  const [scope, setScope] = useState<CustomFieldScope>('TASK');
  const definitions = useCustomFieldDefinitions({ scope });
  const projects = useProjects({ pageSize: 500, sort: 'name', order: 'asc' });
  const projectName = new Map((projects.data?.items ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Custom fields</h1>
        <p className="text-ink-muted text-sm">
          Define typed fields that can be attached to tasks, projects, leads, or clients.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <Label className="text-ink-muted text-xs uppercase tracking-wide">Scope</Label>
        <Select value={scope} onValueChange={(v) => setScope(v as CustomFieldScope)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <CreateForm
        scope={scope}
        projects={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
      />

      <ul className="space-y-2" role="list">
        {definitions.isLoading ? (
          <li className="flex justify-center">
            <Loader size="sm" label="Loading" />
          </li>
        ) : definitions.isError && !definitions.data ? (
          <li>
            <QueryError
              message="Couldn't load custom fields."
              onRetry={() => void definitions.refetch()}
            />
          </li>
        ) : definitions.data && definitions.data.length === 0 ? (
          <li className="border-line bg-bg-surface text-ink-muted rounded-md border border-dashed p-4 text-xs">
            No {scope.toLowerCase()} fields yet.
          </li>
        ) : (
          definitions.data
            ?.filter((d) => d.scope === scope)
            .map((d) => (
              <DefinitionRow
                key={d.id}
                def={d}
                projectName={d.projectId ? (projectName.get(d.projectId) ?? 'A project') : null}
              />
            ))
        )}
      </ul>
    </div>
  );
}

function CreateForm({
  scope,
  projects,
}: {
  scope: CustomFieldScope;
  projects: { value: string; label: string }[];
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [type, setType] = useState<CustomFieldType>('TEXT');
  const [optionsRaw, setOptionsRaw] = useState('');
  const create = useCreateCustomFieldDefinition();

  const reset = () => {
    setName('');
    setKey('');
    setType('TEXT');
    setOptionsRaw('');
  };

  const needsOptions = type === 'SELECT' || type === 'MULTI_SELECT';
  // The API requires a project for task fields (tasks live in a project).
  const needsProject = scope === 'TASK';

  const submit = () => {
    if (!name.trim() || !key.trim()) return;
    if (needsProject && !projectId) return;
    const input: CreateCustomFieldDefinitionInput = {
      scope,
      name: name.trim(),
      key: key.trim(),
      type,
      ...(needsProject && projectId ? { projectId } : {}),
    };
    if (needsOptions) {
      const opts = optionsRaw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => ({ value: v, label: v }));
      input.options = opts;
    }
    create.mutate(input, { onSuccess: reset });
  };

  return (
    <div className="border-line bg-bg-subtle rounded-md border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          placeholder="key_snake_case"
          value={key}
          onChange={(e) => setKey(e.target.value.toLowerCase())}
        />
        <Select value={type} onValueChange={(v) => setType(v as CustomFieldType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={submit}
          disabled={create.isPending || !name || !key || (needsProject && !projectId)}
        >
          <Plus className="mr-1 h-4 w-4" /> Add field
        </Button>
      </div>
      {needsProject ? (
        <div className="mt-2">
          <Combobox
            options={projects}
            value={projectId}
            onChange={setProjectId}
            placeholder="Project the field belongs to"
            searchPlaceholder="Search projects…"
            emptyText="No projects."
          />
        </div>
      ) : null}
      {needsOptions ? (
        <Input
          className="mt-2"
          placeholder="Comma-separated options (e.g. low,medium,high)"
          value={optionsRaw}
          onChange={(e) => setOptionsRaw(e.target.value)}
        />
      ) : null}
    </div>
  );
}

function DefinitionRow({
  def,
  projectName,
}: {
  def: CustomFieldDefinition;
  projectName: string | null;
}) {
  const update = useUpdateCustomFieldDefinition();
  const remove = useDeleteCustomFieldDefinition();

  return (
    <li className="border-line bg-bg-surface flex items-center gap-3 rounded-md border px-3 py-2">
      <Input
        defaultValue={def.name}
        onBlur={(e) => {
          if (e.target.value !== def.name) {
            update.mutate({ id: def.id, input: { name: e.target.value } });
          }
        }}
        className="flex-1"
      />
      {projectName ? (
        <span className="text-ink-muted max-w-[10rem] truncate text-[11px]" title={projectName}>
          {projectName}
        </span>
      ) : null}
      <span className="text-ink-disabled font-mono text-[11px]">{def.key}</span>
      <span className="text-ink-muted text-[11px] uppercase tracking-wide">{def.type}</span>
      <label className="text-ink-muted flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={def.required}
          onChange={(e) => update.mutate({ id: def.id, input: { required: e.target.checked } })}
          className="accent-brand-600 h-3.5 w-3.5"
        />
        Required
      </label>
      <button
        type="button"
        aria-label={`Delete ${def.name}`}
        onClick={() => {
          if (window.confirm(`Delete custom field "${def.name}"?`)) {
            remove.mutate(def.id);
          }
        }}
        className="text-ink-disabled hover:bg-tint-error hover:text-state-error focus-visible:shadow-focus rounded p-1.5 focus-visible:outline-none focus-visible:ring-2"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
