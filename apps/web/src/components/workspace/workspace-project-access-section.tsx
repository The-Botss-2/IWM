'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Lock, Search, Users } from 'lucide-react';
import type {
  ProjectVisibility,
  ProjectWithCreator,
  SessionContext,
  Workspace,
} from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjects, useUpdateProject } from '@/hooks/use-projects';

/**
 * Per-project read access, managed from one screen.
 *
 * `Project.visibility` is the switch. WORKSPACE / PUBLIC means every member of
 * the workspace can open the project; PRIVATE narrows it to the project's own
 * members. The server is authoritative - `projectAccessWhere` in the API
 * applies the same rule to the project itself AND to everything hanging off it
 * (tasks, sprints, goals, comments, calendar entries, search hits), so a
 * hidden project does not leak through a side door.
 *
 * Workspace owners, workspace admins and org admins always see every project
 * regardless of this setting, which is why they are the only ones shown this
 * section at all.
 */

const VISIBILITY_OPTIONS: {
  value: ProjectVisibility;
  label: string;
}[] = [
  { value: 'WORKSPACE', label: 'Everyone in workspace' },
  { value: 'PRIVATE', label: 'Members only' },
];

export function WorkspaceProjectAccessSection({
  workspace,
}: {
  workspace: Workspace;
}) {
  const session = useSessionContext();
  const canManage = useMemo(() => {
    const data = session.data as SessionContext | undefined;
    if (!data) return false;
    const systemRole = data.user?.systemRole;
    if (systemRole === 'ADMIN' || systemRole === 'SUPER_ADMIN') return true;
    const membership = data.workspaceMemberships.find(
      (m) => m.workspaceId === workspace.id,
    );
    return membership?.role === 'OWNER' || membership?.role === 'ADMIN';
  }, [session.data, workspace.id]);

  // Pull a generous page: this is an admin screen, and paginating a settings
  // table would make "which projects are hidden?" harder to answer at a glance
  // than just scrolling.
  const projects = useProjects({ pageSize: 100, sort: 'name', order: 'asc' });
  const [filter, setFilter] = useState('');

  const items = useMemo(() => {
    const all = projects.data?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q),
    );
  }, [projects.data, filter]);

  // Members see nothing here - the whole section is an admin control, and
  // rendering a read-only copy would just advertise which projects are hidden.
  if (!canManage) return null;

  return (
    <section
      aria-labelledby="project-access-heading"
      className="rounded-lg border border-line bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="project-access-heading"
            className="text-base font-semibold text-ink"
          >
            Project access
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Choose who can see each project. Setting one to{' '}
            <span className="font-medium text-ink">Members only</span> hides it
            from everyone except the people added to it, along with its tasks,
            sprints, goals, calendar entries and search results. You and other
            workspace admins always see everything.
          </p>
        </div>
        {(projects.data?.items.length ?? 0) > 8 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              aria-label="Filter projects"
              className="w-56 pl-8"
            />
          </div>
        ) : null}
      </div>

      <div className="mt-5">
        {projects.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : projects.isError ? (
          <p className="text-sm text-state-error">Couldn&apos;t load projects.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {filter.trim()
              ? 'No projects match that filter.'
              : 'This workspace has no projects yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((project) => (
              <ProjectAccessRow key={project.id} project={project} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProjectAccessRow({ project }: { project: ProjectWithCreator }) {
  // One mutation hook per row rather than one shared hook: `useUpdateProject`
  // is keyed by project id so it can patch that project's own caches.
  const update = useUpdateProject(project.id);
  const isPrivate = project.visibility === 'PRIVATE';
  const memberCount = project.memberCount ?? 0;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${project.id}`}
            className="truncate font-medium text-ink hover:underline"
          >
            {project.name}
          </Link>
          <Badge tone="outline" className="font-mono text-xs">
            {project.key}
          </Badge>
          {isPrivate ? (
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <Lock className="h-3 w-3" aria-hidden />
              Hidden
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
          <Users className="h-3 w-3" aria-hidden />
          {isPrivate
            ? `${memberCount} ${memberCount === 1 ? 'person' : 'people'} can see this`
            : 'Everyone in the workspace can see this'}
          {isPrivate ? (
            <Link
              href={`/projects/${project.id}?view=settings`}
              className="underline hover:text-ink"
            >
              Manage members
            </Link>
          ) : null}
        </p>
      </div>

      <Select
        value={project.visibility}
        disabled={update.isPending}
        onValueChange={(v) => update.mutate({ visibility: v as ProjectVisibility })}
      >
        <SelectTrigger
          className="w-56"
          aria-label={`Visibility for ${project.name}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VISIBILITY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          {/* PUBLIC is a legacy value the old per-project dropdown could set.
              Keep it selectable ONLY when a project already carries it, so
              opening this screen never silently rewrites an existing choice -
              but do not offer it as a new option, since it behaves exactly
              like WORKSPACE. */}
          {project.visibility === 'PUBLIC' ? (
            <SelectItem value="PUBLIC">Public (legacy)</SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </li>
  );
}
