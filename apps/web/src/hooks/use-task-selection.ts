'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Cross-view selection state for Board + List. Persisted in memory only so a
 * page reload clears the selection (intentional - selection is ephemeral).
 *
 * The selection is namespaced by projectId so jumping between projects from the
 * sidebar doesn't accidentally bulk-mutate the wrong tasks.
 */
interface SelectionState {
  projectId: string | null;
  ids: Set<string>;
  /** The most recently clicked id, used as the anchor for Shift+Click ranges. */
  anchor: string | null;
  scope: (projectId: string) => void;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  setOne: (id: string) => void;
  range: (orderedIds: string[], id: string) => void;
  selectMany: (ids: string[]) => void;
  clear: () => void;
}

export const useTaskSelectionStore = create<SelectionState>((set, get) => ({
  projectId: null,
  ids: new Set(),
  anchor: null,
  scope: (projectId) => {
    const current = get();
    if (current.projectId === projectId) return;
    set({ projectId, ids: new Set(), anchor: null });
  },
  has: (id) => get().ids.has(id),
  toggle: (id) => {
    const next = new Set(get().ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ ids: next, anchor: id });
  },
  setOne: (id) => set({ ids: new Set([id]), anchor: id }),
  range: (orderedIds, id) => {
    const anchor = get().anchor;
    if (!anchor || anchor === id) {
      const next = new Set(get().ids);
      next.add(id);
      set({ ids: next, anchor: id });
      return;
    }
    const i = orderedIds.indexOf(anchor);
    const j = orderedIds.indexOf(id);
    if (i === -1 || j === -1) {
      const next = new Set(get().ids);
      next.add(id);
      set({ ids: next, anchor: id });
      return;
    }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const next = new Set(get().ids);
    for (let k = lo; k <= hi; k++) {
      const tid = orderedIds[k];
      if (tid) next.add(tid);
    }
    set({ ids: next, anchor: id });
  },
  selectMany: (ids) => set({ ids: new Set(ids), anchor: ids[ids.length - 1] ?? null }),
  clear: () => set({ ids: new Set(), anchor: null }),
}));

/** Scope the selection to the given project. Clears selection on project switch. */
export function useTaskSelection(projectId: string) {
  const scope = useTaskSelectionStore((s) => s.scope);
  useEffect(() => {
    scope(projectId);
  }, [projectId, scope]);
  return {
    ids: useTaskSelectionStore((s) => s.ids),
    has: useTaskSelectionStore((s) => s.has),
    toggle: useTaskSelectionStore((s) => s.toggle),
    setOne: useTaskSelectionStore((s) => s.setOne),
    range: useTaskSelectionStore((s) => s.range),
    selectMany: useTaskSelectionStore((s) => s.selectMany),
    clear: useTaskSelectionStore((s) => s.clear),
  };
}
