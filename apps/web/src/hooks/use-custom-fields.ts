'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldValue,
  ListCustomFieldDefinitionsQuery,
  SetCustomFieldValueInput,
  Task,
  UpdateCustomFieldDefinitionInput,
} from '@botss/shared-types';

import { abilityRow, useAbility } from '@/lib/ability';
import { getApi } from '@/lib/api';
import {
  type CustomFieldPayload,
  formatCustomFieldValue,
  isEmptyValue,
} from '@/lib/custom-field-values';
import { toastError } from '@/lib/toast';
import { customFieldIdOf, type ListColumn } from './use-board-prefs';
import { useWorkspaceMembers } from './use-workspace-members';

const customFieldDefinitionsKey = (q?: Partial<ListCustomFieldDefinitionsQuery>) =>
  ['custom-field-definitions', q ?? {}] as const;

const customFieldValuesKey = (entityId: string) => ['custom-field-values', entityId] as const;

/** Every TASK-field value on one project's tasks (List view columns). */
const projectTaskValuesKey = (projectId: string) =>
  ['custom-field-values', 'project', projectId] as const;

export function useCustomFieldDefinitions(q?: Partial<ListCustomFieldDefinitionsQuery>) {
  return useQuery({
    queryKey: customFieldDefinitionsKey(q),
    queryFn: () => getApi().customFields.listDefinitions(q),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export function useCreateCustomFieldDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomFieldDefinitionInput) =>
      getApi().customFields.createDefinition(input),
    meta: { successMessage: 'Custom field created.', errorTitle: "Couldn't create custom field" },
    onSuccess: (created) => {
      // Append to every cached list the new field belongs in; no
      // invalidation - the settings page reads through this cache and a
      // refetch would clobber any in-flight edits.
      const caches = qc.getQueriesData<CustomFieldDefinition[]>({
        queryKey: ['custom-field-definitions'],
      });
      for (const [key, data] of caches) {
        if (!data) continue;
        const q = (key[1] ?? {}) as Partial<ListCustomFieldDefinitionsQuery>;
        if (q.scope && q.scope !== created.scope) continue;
        if (q.projectId !== undefined && q.projectId !== created.projectId) continue;
        qc.setQueryData<CustomFieldDefinition[]>(key, [...data, created]);
      }
    },
  });
}

export function useUpdateCustomFieldDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCustomFieldDefinitionInput }) =>
      getApi().customFields.updateDefinition(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['custom-field-definitions'] });
      const snapshots = qc.getQueriesData<CustomFieldDefinition[]>({
        queryKey: ['custom-field-definitions'],
      });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<CustomFieldDefinition[]>(
          key,
          data.map((d) => (d.id === id ? { ...d, ...input } : d)),
        );
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
      }
      toastError(err, "Couldn't update custom field");
    },
  });
}

export function useDeleteCustomFieldDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().customFields.deleteDefinition(id),
    meta: { successMessage: 'Custom field deleted.' },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['custom-field-definitions'] });
      const snapshots = qc.getQueriesData<CustomFieldDefinition[]>({
        queryKey: ['custom-field-definitions'],
      });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<CustomFieldDefinition[]>(
          key,
          data.filter((d) => d.id !== id),
        );
      }
      return { snapshots };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
      }
      toastError(err, "Couldn't delete custom field");
    },
  });
}

export function useCustomFieldValues(entityId: string | null | undefined) {
  return useQuery({
    queryKey: customFieldValuesKey(entityId ?? ''),
    queryFn: () => getApi().customFields.listValues(entityId as string),
    enabled: !!entityId,
    staleTime: 10_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

/** Every TASK-field value on a project's tasks, in one read (List view). */
export function useProjectTaskCustomFieldValues(
  projectId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: projectTaskValuesKey(projectId ?? ''),
    queryFn: () => getApi().customFields.listProjectTaskValues(projectId as string),
    enabled: !!projectId && enabled,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

type ValueCaches = Array<[readonly unknown[], CustomFieldValue[] | undefined]>;

/**
 * Patch the entity's value list and, when given, its project's list. Only
 * loaded lists are patched, except that `seedEntity` creates the entity's
 * list for an optimistic first value.
 */
function patchValueCaches(
  qc: QueryClient,
  entityId: string,
  projectId: string | undefined,
  patch: (list: CustomFieldValue[]) => CustomFieldValue[],
  seedEntity = false,
): ValueCaches {
  const keys: Array<readonly unknown[]> = [customFieldValuesKey(entityId)];
  if (projectId) keys.push(projectTaskValuesKey(projectId));
  const snapshots: ValueCaches = [];
  for (const key of keys) {
    const data = qc.getQueryData<CustomFieldValue[]>(key);
    snapshots.push([key, data]);
    if (data) qc.setQueryData<CustomFieldValue[]>(key, patch(data));
    else if (seedEntity && key === keys[0]) qc.setQueryData<CustomFieldValue[]>(key, patch([]));
  }
  return snapshots;
}

function restoreValueCaches(qc: QueryClient, snapshots: ValueCaches | undefined) {
  for (const [key, data] of snapshots ?? []) qc.setQueryData(key, data);
}

/**
 * Optimistic set (feedback §4: no invalidation - the task panel is reading
 * these caches while the person edits). The server's row is merged in on
 * success so the temp id gets its real one.
 */
export function useSetCustomFieldValue(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetCustomFieldValueInput) => getApi().customFields.setValue(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: customFieldValuesKey(input.entityId) });
      if (projectId) await qc.cancelQueries({ queryKey: projectTaskValuesKey(projectId) });
      const now = new Date();
      const snapshots = patchValueCaches(
        qc,
        input.entityId,
        projectId,
        (list) => {
          const prev = list.find(
            (v) => v.definitionId === input.definitionId && v.entityId === input.entityId,
          );
          const optimistic: CustomFieldValue = {
            id: prev?.id ?? `temp-${input.definitionId}-${input.entityId}`,
            definitionId: input.definitionId,
            entityId: input.entityId,
            value: input.value,
            createdAt: prev?.createdAt ?? now,
            updatedAt: now,
          };
          return prev ? list.map((v) => (v === prev ? optimistic : v)) : [...list, optimistic];
        },
        true,
      );
      return { snapshots };
    },
    onSuccess: (saved) => {
      patchValueCaches(qc, saved.entityId, projectId, (list) =>
        list.map((v) =>
          v.definitionId === saved.definitionId && v.entityId === saved.entityId ? saved : v,
        ),
      );
    },
    onError: (err, _input, ctx) => {
      restoreValueCaches(qc, ctx?.snapshots);
      toastError(err, "Couldn't save value");
    },
  });
}

/** Optimistic clear of a saved value (by its id), no invalidation (§4). */
export function useClearCustomFieldValue(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: CustomFieldValue) => getApi().customFields.clearValue(value.id),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: customFieldValuesKey(value.entityId) });
      if (projectId) await qc.cancelQueries({ queryKey: projectTaskValuesKey(projectId) });
      const snapshots = patchValueCaches(qc, value.entityId, projectId, (list) =>
        list.filter((v) => v.id !== value.id),
      );
      return { snapshots };
    },
    onError: (err, _value, ctx) => {
      restoreValueCaches(qc, ctx?.snapshots);
      toastError(err, "Couldn't clear value");
    },
  });
}

export interface TaskCustomField {
  definition: CustomFieldDefinition;
  value: CustomFieldPayload;
}

/**
 * The task's project TASK fields joined with this task's values, in the
 * order set in Settings. `readOnly` mirrors the API's check (update on this
 * task row) and is a UX hint only. Every save is one request.
 */
export function useTaskCustomFields(
  task: Pick<Task, 'id' | 'projectId' | 'status' | 'createdById' | 'assigneeId'>,
) {
  const ability = useAbility();
  const definitions = useCustomFieldDefinitions({ scope: 'TASK', projectId: task.projectId });
  const values = useCustomFieldValues(task.id);
  const set = useSetCustomFieldValue(task.projectId);
  const clear = useClearCustomFieldValue(task.projectId);

  const fields = useMemo<TaskCustomField[]>(() => {
    const byDef = new Map((values.data ?? []).map((v) => [v.definitionId, v.value]));
    return [...(definitions.data ?? [])]
      .filter((d) => d.scope === 'TASK' && d.projectId === task.projectId)
      .sort((a, b) => a.position - b.position)
      .map((definition) => ({ definition, value: byDef.get(definition.id) ?? null }));
  }, [definitions.data, values.data, task.projectId]);

  /** Save a value; an empty one (null, '', []) clears the field instead. */
  const save = (definitionId: string, value: CustomFieldPayload) => {
    const current = (values.data ?? []).find((v) => v.definitionId === definitionId);
    if (!isEmptyValue(value)) {
      set.mutate({ definitionId, entityId: task.id, value });
      return;
    }
    if (!current || isEmptyValue(current.value)) return;
    // A value whose first save is still in flight has no server id to
    // delete yet; storing null clears it just the same, in one request.
    if (current.id.startsWith('temp-')) {
      set.mutate({ definitionId, entityId: task.id, value: null });
    } else {
      clear.mutate(current);
    }
  };

  return {
    fields,
    isLoading: definitions.isLoading || values.isLoading,
    isError: (definitions.isError && !definitions.data) || (values.isError && !values.data),
    refetch: () => {
      void definitions.refetch();
      void values.refetch();
    },
    readOnly: !ability.can('update', abilityRow('Task', task)),
    save,
  };
}

export interface ListFieldColumn {
  column: ListColumn;
  definition: CustomFieldDefinition;
}

/**
 * The List view's visible custom-field columns (in the chosen order, skipping
 * fields deleted since) and a read-only text for each cell. All values come
 * from one per-project read, only while such a column is shown.
 */
export function useTaskListFieldColumns(projectId: string, columns: ListColumn[]) {
  const definitions = useCustomFieldDefinitions({ scope: 'TASK', projectId });
  const fields = useMemo<ListFieldColumn[]>(() => {
    const byId = new Map(
      (definitions.data ?? [])
        .filter((d) => d.scope === 'TASK' && d.projectId === projectId)
        .map((d) => [d.id, d]),
    );
    return columns.flatMap((column) => {
      const id = customFieldIdOf(column);
      const definition = id ? byId.get(id) : undefined;
      return definition ? [{ column, definition }] : [];
    });
  }, [definitions.data, columns, projectId]);

  const values = useProjectTaskCustomFieldValues(projectId, fields.length > 0);
  const needsPeople = fields.some((f) => f.definition.type === 'USER');
  // Same cache as the toolbar's assignee filter, so usually no extra read.
  const members = useWorkspaceMembers(projectId);

  const textFor = useMemo(() => {
    const byKey = new Map(
      (values.data ?? []).map((v) => [`${v.entityId}:${v.definitionId}`, v.value]),
    );
    const names = new Map(
      needsPeople ? (members.data ?? []).map((m) => [m.user.id, m.user.name || m.user.email]) : [],
    );
    return (taskId: string, definition: CustomFieldDefinition): string =>
      formatCustomFieldValue(definition, byKey.get(`${taskId}:${definition.id}`), (id) =>
        names.get(id),
      );
  }, [values.data, members.data, needsPeople]);

  return { fields, textFor };
}
