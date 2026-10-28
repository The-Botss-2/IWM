'use client';

import { useQuery } from '@tanstack/react-query';

import { getApi } from '@/lib/api';

const projectSummaryKey = (projectId: string) => ['project-summary', projectId] as const;

export function useProjectSummary(projectId: string) {
  return useQuery({
    queryKey: projectSummaryKey(projectId),
    queryFn: () => getApi().projectSummary.get(projectId),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
