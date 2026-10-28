'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSprintInput,
  MoveSprintTaskInput,
  ReorderSprintTaskInput,
  Sprint,
  SprintWithStats,
  UpdateSprintInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

const sprintsKey = (projectId: string) => ['sprints', projectId] as const;

const PINNED = {
  staleTime: 30_000,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
};

export function useSprints(projectId: string) {
  return useQuery({
    queryKey: sprintsKey(projectId),
    queryFn: () => getApi().sprints.list(projectId),
    ...PINNED,
  });
}

function patchSprint(
  prev: SprintWithStats[] | undefined,
  id: string,
  patch: (s: SprintWithStats) => SprintWithStats,
): SprintWithStats[] | undefined {
  if (!prev) return prev;
  return prev.map((s) => (s.id === id ? patch(s) : s));
}

export function useCreateSprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSprintInput) => getApi().sprints.create(projectId, input),
    onSuccess: (sprint: Sprint) => {
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (prev) => {
        const next: SprintWithStats = {
          ...sprint,
          taskCount: 0,
          totalEstimateHours: 0,
          taskIds: [],
        };
        return prev ? [next, ...prev] : [next];
      });
    },
    meta: { errorTitle: "Couldn't create sprint" },
  });
}

export function useStartSprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sprintId: string) => getApi().sprints.start(sprintId),
    meta: { successMessage: 'Sprint started.', errorTitle: "Couldn't start sprint" },
    onSuccess: (sprint: Sprint) => {
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (prev) =>
        patchSprint(prev, sprint.id, (s) => ({ ...s, ...sprint })),
      );
    },
  });
}

export function useCompleteSprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sprintId: string) => getApi().sprints.complete(sprintId),
    meta: { successMessage: 'Sprint completed.', errorTitle: "Couldn't complete sprint" },
    onSuccess: (sprint: Sprint) => {
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (prev) =>
        patchSprint(prev, sprint.id, (s) => ({ ...s, ...sprint })),
      );
    },
  });
}

/** What the sprint dialog edits. */
export interface SprintForm {
  name: string;
  goal: string;
  startDate: Date;
  endDate: Date;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Only the fields of a sprint edit that changed; a cleared goal is null. */
export function sprintChanges(sprint: SprintWithStats, next: SprintForm): UpdateSprintInput {
  const out: UpdateSprintInput = {};
  if (next.name !== sprint.name) out.name = next.name;
  const goal = next.goal || null;
  if (goal !== sprint.goal) out.goal = goal;
  if (isoDay(next.startDate) !== isoDay(new Date(sprint.startDate))) out.startDate = next.startDate;
  if (isoDay(next.endDate) !== isoDay(new Date(sprint.endDate))) out.endDate = next.endDate;
  return out;
}

export function useUpdateSprint(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSprintInput }) =>
      getApi().sprints.update(id, input),
    onSuccess: (sprint: Sprint) => {
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (prev) =>
        patchSprint(prev, sprint.id, (s) => ({ ...s, ...sprint })),
      );
    },
    meta: { successMessage: 'Sprint saved.', errorTitle: "Couldn't update sprint" },
  });
}

/**
 * Add a task to a sprint. Used as a fallback when DnD isn't available (mobile
 * touch on a non-DnD path, keyboard); the Backlog view's drag-and-drop calls
 * useMoveSprintTask directly.
 */
export function useAddSprintTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, taskId }: { sprintId: string; taskId: string }) =>
      getApi().sprints.addTask(sprintId, taskId),
    onMutate: ({ sprintId, taskId }) => {
      const prev = qc.getQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId));
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (current) =>
        patchSprint(current, sprintId, (s) => ({
          ...s,
          taskCount: s.taskCount + 1,
          taskIds: s.taskIds.includes(taskId) ? s.taskIds : [...s.taskIds, taskId],
        })),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(sprintsKey(projectId), ctx.prev);
      toastError(err, "Couldn't add task to sprint");
    },
  });
}

export function useRemoveSprintTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, taskId }: { sprintId: string; taskId: string }) =>
      getApi().sprints.removeTask(sprintId, taskId),
    onMutate: ({ sprintId, taskId }) => {
      const prev = qc.getQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId));
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (current) =>
        patchSprint(current, sprintId, (s) => ({
          ...s,
          taskCount: Math.max(0, s.taskCount - 1),
          taskIds: s.taskIds.filter((id) => id !== taskId),
        })),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(sprintsKey(projectId), ctx.prev);
      toastError(err, "Couldn't remove task from sprint");
    },
  });
}

/** Reorder a task within a sprint via 0-based index. */
export function useReorderSprintTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, input }: { sprintId: string; input: ReorderSprintTaskInput }) =>
      getApi().sprints.reorderTask(sprintId, input),
    onMutate: ({ sprintId, input }) => {
      const prev = qc.getQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId));
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (current) =>
        patchSprint(current, sprintId, (s) => {
          const without = s.taskIds.filter((id) => id !== input.taskId);
          const insertAt = Math.min(Math.max(0, input.position), without.length);
          return {
            ...s,
            taskIds: [...without.slice(0, insertAt), input.taskId, ...without.slice(insertAt)],
          };
        }),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(sprintsKey(projectId), ctx.prev);
      toastError(err, "Couldn't reorder task");
    },
  });
}

/** Move a task between two sprints (delete from source, insert into target). */
export function useMoveSprintTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveSprintTaskInput) => getApi().sprints.moveTask(input),
    onMutate: (input) => {
      const prev = qc.getQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId));
      qc.setQueryData<SprintWithStats[] | undefined>(sprintsKey(projectId), (current) =>
        current?.map((s) => {
          if (s.id === input.fromSprintId) {
            return {
              ...s,
              taskCount: Math.max(0, s.taskCount - 1),
              taskIds: s.taskIds.filter((id) => id !== input.taskId),
            };
          }
          if (s.id === input.toSprintId) {
            const without = s.taskIds.filter((id) => id !== input.taskId);
            const insertAt =
              input.position === undefined
                ? without.length
                : Math.min(Math.max(0, input.position), without.length);
            return {
              ...s,
              taskCount: s.taskCount + 1,
              taskIds: [...without.slice(0, insertAt), input.taskId, ...without.slice(insertAt)],
            };
          }
          return s;
        }),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(sprintsKey(projectId), ctx.prev);
      toastError(err, "Couldn't move task");
    },
  });
}
