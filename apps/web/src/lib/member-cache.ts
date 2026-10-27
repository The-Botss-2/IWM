import type { QueryClient } from '@tanstack/react-query';

/** The slice of a cached `['workspace-members', ...]` row the lookups need. */
export type MemberCacheEntry = {
  userId: string;
  user: { id: string; name: string; email: string; image: string | null };
};

/**
 * Look up a user across every cached `['workspace-members', ...]` query, so
 * an optimistic update (new assignee/owner/member) can render the person's
 * name and avatar without an extra fetch. Scans every member cache because
 * the task panel may have populated the per-project pool
 * (`['workspace-members', 'for-project', projectId]`) instead of the user's
 * own workspace, and a single-cache lookup would miss cross-workspace people.
 */
export function findCachedUser(
  qc: QueryClient,
  userId: string,
): MemberCacheEntry['user'] | undefined {
  const caches = qc.getQueriesData<MemberCacheEntry[]>({ queryKey: ['workspace-members'] });
  for (const [, data] of caches) {
    const hit = data?.find((m) => m.userId === userId)?.user;
    if (hit) return hit;
  }
  return undefined;
}
