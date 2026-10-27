'use client';

import { useMemo, useRef } from 'react';
import type { TaskWithPeople } from '@botss/shared-types';

import { useWorkspaceMembers } from '@/hooks/use-workspace-members';

export interface AssigneeOption {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/**
 * People offered by the dashboard's assignee filter: the current workspace's
 * members plus every assignee seen on the overview tasks.
 *
 * The overview is filtered on the server, so once someone is picked the
 * loaded tasks only carry that person - which used to make every other
 * cross-workspace assignee vanish from the list. Seen assignees are therefore
 * remembered (add-only) until the workspace filter changes, when the set of
 * reachable people changes too and the memory starts over.
 */
export function useDashboardAssigneeOptions(
  tasks: readonly TaskWithPeople[],
  workspaceId: string | null,
): AssigneeOption[] {
  const membersQuery = useWorkspaceMembers();
  const seen = useRef<{ workspaceId: string | null; byId: Map<string, AssigneeOption> }>({
    workspaceId,
    byId: new Map(),
  });

  return useMemo(() => {
    if (seen.current.workspaceId !== workspaceId) {
      seen.current = { workspaceId, byId: new Map() };
    }
    const remembered = seen.current.byId;
    for (const t of tasks) {
      if (t.assignee) {
        remembered.set(t.assignee.id, {
          id: t.assignee.id,
          name: t.assignee.name || t.assignee.email,
          email: t.assignee.email,
          image: t.assignee.image,
        });
      }
    }

    const map = new Map<string, AssigneeOption>(remembered);
    // Members win over task snapshots: their profile is the fresher one.
    for (const m of membersQuery.data ?? []) {
      map.set(m.userId, {
        id: m.userId,
        name: m.user.name || m.user.email,
        email: m.user.email,
        image: m.user.image,
      });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [membersQuery.data, tasks, workspaceId]);
}

/**
 * True while the member list behind `useDashboardAssigneeOptions` is still
 * loading, so a chip for a real assignee can say "Loading…" instead of
 * "Unknown member" until names arrive.
 */
export function useDashboardAssigneesLoading(): boolean {
  return useWorkspaceMembers().isPending;
}
