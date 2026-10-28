'use client';

import { useEffect, useState } from 'react';
import type { ProjectStatus, ProjectVisibility, ProjectWithCreator } from '@botss/shared-types';

import { ClientCombobox } from '@/components/clients/client-combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import { useUpdateProject } from '@/hooks/use-projects';
import { toastErrorMessage } from '@/lib/toast';

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'ARCHIVED', label: 'Archived' },
];

const VISIBILITY_OPTIONS: { value: ProjectVisibility; label: string }[] = [
  { value: 'PRIVATE', label: 'Private' },
  { value: 'WORKSPACE', label: 'Workspace' },
  { value: 'PUBLIC', label: 'Public' },
];

const PROJECT_COLORS = [
  '#6366f1',
  '#3b82f6',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
];

const KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;

export function ProjectInfoForm({ project }: { project: ProjectWithCreator }) {
  const update = useUpdateProject(project.id);

  const [name, setName] = useState(project.name);
  const [keyValue, setKeyValue] = useState(project.key);
  const [description, setDescription] = useState(project.description ?? '');

  // Keep local state in sync with cache updates that originate elsewhere.
  useEffect(() => setName(project.name), [project.name]);
  useEffect(() => setKeyValue(project.key), [project.key]);
  useEffect(() => setDescription(project.description ?? ''), [project.description]);

  const save = (input: Parameters<typeof update.mutate>[0]) => update.mutate(input);

  const debouncedSaveDescription = useDebouncedCallback((value: string) => {
    if (value === (project.description ?? '')) return;
    save({ description: value });
  }, 800);

  return (
    <section
      aria-labelledby="project-info-heading"
      className="border-line rounded-lg border bg-white p-5"
    >
      <h2 id="project-info-heading" className="text-ink text-base font-semibold">
        Project info
      </h2>
      <p className="text-ink-muted mt-1 text-sm">Changes save automatically.</p>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (trimmed.length === 0) {
                setName(project.name);
                toastErrorMessage('Project name cannot be empty');
                return;
              }
              if (trimmed === project.name) return;
              save({ name: trimmed });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-key">Key</Label>
          <Input
            id="project-key"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value.toUpperCase())}
            onBlur={() => {
              const next = keyValue.toUpperCase();
              if (next === project.key) return;
              if (!KEY_PATTERN.test(next)) {
                toastErrorMessage('Key must be uppercase letters/digits, starting with a letter');
                setKeyValue(project.key);
                return;
              }
              save({ key: next });
            }}
            aria-describedby="project-key-help"
            className="font-mono"
          />
          <p id="project-key-help" className="text-ink-muted text-xs">
            Uppercase letters and digits, e.g. <span className="font-mono">BG</span>.
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="project-description">Description</Label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              debouncedSaveDescription(e.target.value);
            }}
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-status">Status</Label>
          <Select
            value={project.status}
            onValueChange={(v) => save({ status: v as ProjectStatus })}
          >
            <SelectTrigger id="project-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-visibility">Visibility</Label>
          <Select
            value={project.visibility}
            onValueChange={(v) => save({ visibility: v as ProjectVisibility })}
          >
            <SelectTrigger id="project-visibility">
              <SelectValue placeholder="Visibility" />
            </SelectTrigger>
            <SelectContent>
              {VISIBILITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-start">Start date</Label>
          <DatePicker
            value={project.startDate}
            onChange={(d) => save({ startDate: d ?? undefined })}
            placeholder="No start date"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="project-due">Due date</Label>
          <DatePicker
            value={project.dueDate}
            onChange={(d) => save({ dueDate: d ?? undefined })}
            placeholder="No due date"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Color</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Project color">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={project.color === c}
                aria-label={`Color ${c}`}
                onClick={() => save({ color: c })}
                className={`focus-visible:shadow-focus h-8 w-8 rounded-full border-2 transition focus-visible:outline-none focus-visible:ring-2 ${
                  project.color === c
                    ? 'border-slate-900'
                    : 'hover:border-line-strong border-transparent'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Client</Label>
          <ClientCombobox
            value={project.clientId}
            onChange={(clientId) => save({ clientId })}
            placeholder="No client"
          />
        </div>
      </div>
    </section>
  );
}
