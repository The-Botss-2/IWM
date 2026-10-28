'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGoalInput,
  CreateGoalUpdateInput,
  CreateKeyResultInput,
  Goal,
  GoalWithDetails,
  UpdateGoalInput,
  UpdateKeyResultInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';

const PINNED = {
  staleTime: 30_000,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
};

const goalsKey = (projectId: string) => ['goals', projectId] as const;
const goalUpdatesKey = (goalId: string) => ['goal-updates', goalId] as const;

export function useGoals(projectId: string) {
  return useQuery({
    queryKey: goalsKey(projectId),
    queryFn: () => getApi().goals.list(projectId),
    ...PINNED,
  });
}

export function useGoalUpdates(goalId: string | null) {
  return useQuery({
    queryKey: goalId ? goalUpdatesKey(goalId) : ['goal-updates', 'none'],
    queryFn: () => (goalId ? getApi().goals.updates(goalId) : Promise.resolve([])),
    enabled: !!goalId,
    ...PINNED,
  });
}

export function useCreateGoal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGoalInput) => getApi().goals.create(projectId, input),
    onSuccess: (goal: Goal) => {
      qc.invalidateQueries({ queryKey: goalsKey(projectId) });
      void goal;
    },
    meta: { errorTitle: "Couldn't create goal" },
  });
}

export function useUpdateGoal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateGoalInput }) =>
      getApi().goals.update(id, input),
    onSuccess: (goal: Goal, vars) => {
      qc.setQueryData<GoalWithDetails[] | undefined>(goalsKey(projectId), (prev) =>
        prev?.map((g) => (g.id === goal.id ? { ...g, ...goal } : g)),
      );
      // The response is the bare goal: a new owner's name and avatar only
      // come with the joined list. Nothing edits that list in place (the
      // dialog has closed), so the refetch is safe.
      if (vars.input.ownerId !== undefined) {
        void qc.invalidateQueries({ queryKey: goalsKey(projectId) });
      }
    },
    meta: { successMessage: 'Goal saved.', errorTitle: "Couldn't update goal" },
  });
}

/** Only the fields of a goal edit that differ from the stored goal. */
export function goalChanges(goal: GoalWithDetails, next: UpdateGoalInput): UpdateGoalInput {
  const out: UpdateGoalInput = {};
  if (next.title !== undefined && next.title !== goal.title) out.title = next.title;
  if (next.description !== undefined && next.description !== (goal.description ?? '')) {
    out.description = next.description;
  }
  if (next.ownerId !== undefined && next.ownerId !== goal.ownerId) out.ownerId = next.ownerId;
  if (next.status !== undefined && next.status !== goal.status) out.status = next.status;
  const sameDay = (a: Date, b: Date) =>
    a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  if (next.startDate && !sameDay(next.startDate, new Date(goal.startDate)))
    out.startDate = next.startDate;
  if (next.endDate && !sameDay(next.endDate, new Date(goal.endDate))) out.endDate = next.endDate;
  return out;
}

export function useDeleteGoal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().goals.remove(id),
    meta: { successMessage: 'Goal deleted.', errorTitle: "Couldn't delete goal" },
    onMutate: (id) => {
      qc.setQueryData<GoalWithDetails[] | undefined>(goalsKey(projectId), (prev) =>
        prev?.filter((g) => g.id !== id),
      );
    },
  });
}

export function useCreateKeyResult(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, input }: { goalId: string; input: CreateKeyResultInput }) =>
      getApi().goals.createKeyResult(goalId, input),
    onSuccess: (_kr, vars) => {
      qc.invalidateQueries({ queryKey: goalsKey(projectId) });
      void vars;
    },
    meta: { errorTitle: "Couldn't create key result" },
  });
}

export function useUpdateKeyResult(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateKeyResultInput }) =>
      getApi().goals.updateKeyResult(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalsKey(projectId) }),
    meta: { errorTitle: "Couldn't update key result" },
  });
}

/**
 * Optimistic: the key result leaves the goal at once and comes back on
 * error. The goal's progress is computed on the server from its remaining
 * key results, so the list is re-read once the delete settles; the key result
 * inputs are uncontrolled (`defaultValue`), so a refetch cannot overwrite
 * what someone is typing.
 */
export function useDeleteKeyResult(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (krId: string) => getApi().goals.removeKeyResult(krId),
    onMutate: async (krId) => {
      const key = goalsKey(projectId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<GoalWithDetails[]>(key);
      qc.setQueryData<GoalWithDetails[] | undefined>(key, (prev) =>
        prev?.map((g) => ({ ...g, keyResults: g.keyResults.filter((k) => k.id !== krId) })),
      );
      return { previous };
    },
    onError: (_err, _krId, ctx) => {
      if (ctx?.previous) qc.setQueryData(goalsKey(projectId), ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: goalsKey(projectId) }),
    meta: { successMessage: 'Key result deleted.', errorTitle: "Couldn't delete key result" },
  });
}

export function useCreateGoalUpdate(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, input }: { goalId: string; input: CreateGoalUpdateInput }) =>
      getApi().goals.createUpdate(goalId, input),
    onSuccess: (_u, vars) => {
      qc.invalidateQueries({ queryKey: goalUpdatesKey(vars.goalId) });
      qc.invalidateQueries({ queryKey: goalsKey(projectId) });
    },
    meta: { errorTitle: "Couldn't post update" },
  });
}
