'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectWithCreator,
  UpdateProjectInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

const projectsKey = (q?: Partial<ListProjectsQuery>) => ['projects', q ?? {}] as const;
export const projectKey = (id: string) => ['projects', id] as const;

type ProjectListPage = { items: ProjectWithCreator[] } & Record<string, unknown>;

export function useProjects(q?: Partial<ListProjectsQuery>) {
  return useQuery({
    queryKey: projectsKey(q),
    queryFn: () => getApi().projects.list(q),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKey(id),
    queryFn: () => getApi().projects.get(id),
    enabled: !!id,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => getApi().projects.create(input),
    meta: { successMessage: 'Project created.', errorTitle: "Couldn't create project" },
    onSuccess: (created) => {
      // Best-effort insert at the top of cached project lists. The server's
      // canonical shape will surface on the next manual load; no refetch here.
      const pages = qc.getQueriesData<ProjectListPage>({ queryKey: ['projects'] });
      for (const [key, data] of pages) {
        if (!data?.items) continue;
        if (Array.isArray((key as unknown[])[1])) continue;
        // Synthesize a creator placeholder; the panel/list never needs more
        // than the workspace can see, and the cache will be replaced when the
        // user opens this project's detail page.
        const placeholder: ProjectWithCreator = {
          ...created,
          createdBy: {
            id: created.createdById,
            name: 'You',
            email: '',
            image: null,
          },
        };
        qc.setQueryData<ProjectListPage>(key, {
          ...data,
          items: [placeholder, ...data.items],
        });
      }
    },
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => getApi().projects.update(id, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['projects'] });
      // Patch the single-project cache used by the detail page.
      const previousProject = qc.getQueryData<ProjectWithCreator>(projectKey(id));
      if (previousProject) {
        qc.setQueryData<ProjectWithCreator>(projectKey(id), {
          ...previousProject,
          ...input,
          // Preserve nested objects we don't replace.
          createdBy: previousProject.createdBy,
          updatedAt: new Date(),
        });
      }
      // Patch any list pages that include this project.
      const previousPages = qc.getQueriesData<ProjectListPage>({ queryKey: ['projects'] });
      for (const [key, data] of previousPages) {
        if (!data?.items) continue;
        qc.setQueryData<ProjectListPage>(key, {
          ...data,
          items: data.items.map((p) =>
            p.id === id ? { ...p, ...input, createdBy: p.createdBy, updatedAt: new Date() } : p,
          ),
        });
      }
      return { previousProject, previousPages };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previousProject) qc.setQueryData(projectKey(id), ctx.previousProject);
      if (ctx?.previousPages) {
        for (const [key, data] of ctx.previousPages) qc.setQueryData(key, data);
      }
      toastError(err, "Couldn't save project");
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().projects.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['projects'] });
      const previousPages = qc.getQueriesData<ProjectListPage>({ queryKey: ['projects'] });
      for (const [key, data] of previousPages) {
        if (!data?.items) continue;
        qc.setQueryData<ProjectListPage>(key, {
          ...data,
          items: data.items.filter((p) => p.id !== id),
        });
      }
      return { previousPages };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previousPages) {
        for (const [key, data] of ctx.previousPages) qc.setQueryData(key, data);
      }
      toastError(err, "Couldn't delete project");
    },
  });
}
