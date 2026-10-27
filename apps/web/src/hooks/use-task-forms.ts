'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTaskFormInput,
  TaskForm,
  UpdateTaskFormInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';

const PINNED = {
  staleTime: 30_000,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
};

const taskFormsKey = (projectId: string) => ['task-forms', projectId] as const;
const taskFormSubmissionsKey = (formId: string) =>
  ['task-forms', 'submissions', formId] as const;

export function useTaskForms(projectId: string) {
  return useQuery({
    queryKey: taskFormsKey(projectId),
    queryFn: () => getApi().taskForms.list(projectId),
    ...PINNED,
  });
}

export function useCreateTaskForm(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskFormInput) => getApi().taskForms.create(projectId, input),
    onSuccess: (form: TaskForm) => {
      qc.setQueryData<TaskForm[] | undefined>(taskFormsKey(projectId), (prev) =>
        prev ? [form, ...prev] : [form],
      );
    },
    meta: { errorTitle: "Couldn't create form" },
  });
}

export function useUpdateTaskForm(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskFormInput }) =>
      getApi().taskForms.update(id, input),
    onSuccess: (form: TaskForm) => {
      qc.setQueryData<TaskForm[] | undefined>(taskFormsKey(projectId), (prev) =>
        prev?.map((f) => (f.id === form.id ? form : f)),
      );
    },
    meta: { errorTitle: "Couldn't update form" },
  });
}

export function useDeleteTaskForm(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().taskForms.remove(id),
    meta: { successMessage: 'Form deleted.', errorTitle: "Couldn't delete form" },
    onMutate: (id) => {
      qc.setQueryData<TaskForm[] | undefined>(taskFormsKey(projectId), (prev) =>
        prev?.filter((f) => f.id !== id),
      );
    },
  });
}
