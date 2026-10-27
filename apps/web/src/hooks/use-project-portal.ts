'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '@botss/api-client';
import type {
  ProjectStatus,
  ProjectWithCreator,
  TaskStatus,
  UpdateProjectPortalInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { describeError, toastErrorMessage } from '@/lib/toast';
import { patchEvery, snapshotPages } from './tasks/query-helpers';

/**
 * What a project's client sees in the client portal. Both routes answer 403
 * unless the user is a workspace owner or admin, an org admin, or the
 * project's lead; the toast says so instead of a generic failure.
 */
/**
 * Project statuses the client portal lists. Mirrors PORTAL_PROJECT_STATUSES
 * in apps/api/src/portal/portal-rules.ts: drafts are not started yet and
 * archived projects are gone, so neither shows even when switched on.
 */
const PORTAL_PROJECT_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
]);

/** Whether a project in this status can appear in the client portal. */
export function portalListsProjectStatus(status: ProjectStatus): boolean {
  return PORTAL_PROJECT_STATUSES.has(status);
}

/** Cancelled tasks are never listed in the portal, marked or not. */
export function portalListsTaskStatus(status: TaskStatus): boolean {
  return status !== 'CANCELLED';
}

const PORTAL_FORBIDDEN =
  'Only workspace owners and admins, or the project lead, can change what the client sees.';

function portalErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) return PORTAL_FORBIDDEN;
  return describeError(err, fallback);
}

// ---------------------------------------------------------------------------
// Project: shown in the portal, and all tasks or only marked ones
// ---------------------------------------------------------------------------

type PortalFlags = Pick<ProjectWithCreator, 'portalVisible' | 'portalShowAllTasks'>;
type ProjectListPage = { items: ProjectWithCreator[] } & Record<string, unknown>;
type ProjectCacheEntry = ProjectWithCreator | ProjectListPage;

function isListPage(data: ProjectCacheEntry): data is ProjectListPage {
  return Array.isArray((data as ProjectListPage).items);
}

/** Only the flags this update sets; the other one stays as cached. */
function flagsOf(input: UpdateProjectPortalInput): PortalFlags {
  const flags: PortalFlags = {};
  if (input.portalVisible !== undefined) flags.portalVisible = input.portalVisible;
  if (input.portalShowAllTasks !== undefined) flags.portalShowAllTasks = input.portalShowAllTasks;
  return flags;
}

/** Apply `flags` to this project in every `['projects', ...]` cache entry:
 *  the detail object (`projectKey`) and every list page that holds it. */
function patchProjectCaches(qc: QueryClient, projectId: string, flags: PortalFlags) {
  for (const [key, data] of qc.getQueriesData<ProjectCacheEntry>({ queryKey: ['projects'] })) {
    if (!data || typeof data !== 'object') continue;
    if (isListPage(data)) {
      qc.setQueryData<ProjectListPage>(key, {
        ...data,
        items: data.items.map((p) => (p.id === projectId ? { ...p, ...flags } : p)),
      });
    } else if (data.id === projectId) {
      qc.setQueryData<ProjectWithCreator>(key, { ...data, ...flags });
    }
  }
}

/** The project's current flags from whichever cache entry holds it. */
function cachedFlags(qc: QueryClient, projectId: string): PortalFlags | undefined {
  for (const [, data] of qc.getQueriesData<ProjectCacheEntry>({ queryKey: ['projects'] })) {
    if (!data || typeof data !== 'object') continue;
    const project = isListPage(data)
      ? data.items.find((p) => p.id === projectId)
      : data.id === projectId
        ? data
        : undefined;
    if (project) {
      return { portalVisible: project.portalVisible, portalShowAllTasks: project.portalShowAllTasks };
    }
  }
  return undefined;
}

export function useUpdateProjectPortal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update portal settings" },
    mutationFn: (input: UpdateProjectPortalInput) =>
      getApi().projects.updatePortal(projectId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['projects'] });
      const previous = cachedFlags(qc, projectId);
      patchProjectCaches(qc, projectId, flagsOf(input));
      return { previous };
    },
    onSuccess: (server) => {
      patchProjectCaches(qc, projectId, {
        portalVisible: server.portalVisible,
        portalShowAllTasks: server.portalShowAllTasks,
      });
    },
    onError: (err, input, ctx) => {
      // Roll back only the flags this call touched, never other edits.
      if (ctx?.previous) {
        const rollback: PortalFlags = {};
        if (input.portalVisible !== undefined) rollback.portalVisible = ctx.previous.portalVisible;
        if (input.portalShowAllTasks !== undefined) {
          rollback.portalShowAllTasks = ctx.previous.portalShowAllTasks;
        }
        patchProjectCaches(qc, projectId, rollback);
      }
      toastErrorMessage("Couldn't update the client portal settings", {
        description: portalErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Task: listed for the client while the project shows marked tasks only
// ---------------------------------------------------------------------------

/**
 * Task caches are patched in place, never refetched after a write: every
 * task hook works this way (see `use-tasks.ts` and the "kanban reorder loop"
 * it avoids), and a refetch here could overwrite another in-flight
 * optimistic task edit. The patch covers every cached `['tasks', ...]` page,
 * which is where the board, list and task panel read from.
 */
export function useUpdateTaskPortalVisibility() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update task visibility" },
    mutationFn: ({ taskId, portalVisible }: { taskId: string; portalVisible: boolean }) =>
      getApi().tasks.updatePortalVisibility(taskId, { portalVisible }),
    onMutate: async ({ taskId, portalVisible }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      let previous: boolean | undefined;
      for (const [, page] of snapshotPages(qc)) {
        const hit = page?.items?.find((t) => t.id === taskId);
        if (hit) {
          previous = hit.portalVisible;
          break;
        }
      }
      patchEvery(qc, taskId, (t) => ({ ...t, portalVisible }));
      return { previous };
    },
    onSuccess: (server) => {
      patchEvery(qc, server.id, (t) => ({ ...t, portalVisible: server.portalVisible }));
    },
    onError: (err, { taskId }, ctx) => {
      // Roll back only this flag (absent reads as false), never other edits.
      if (ctx) patchEvery(qc, taskId, (t) => ({ ...t, portalVisible: ctx.previous }));
      toastErrorMessage("Couldn't change whether the client sees this task", {
        description: portalErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      });
    },
  });
}
