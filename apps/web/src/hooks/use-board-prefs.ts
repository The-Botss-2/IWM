'use client';

import { useCallback, useEffect, useState } from 'react';

import { useSession } from '@/lib/auth-client';

export type BoardDensity = 'compact' | 'normal' | 'detailed';
export type BoardGroupBy = 'none' | 'assignee' | 'priority' | 'epic';
export type ListGroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'sprint';

const DENSITY_DEFAULT: BoardDensity = 'normal';
const DENSITIES: BoardDensity[] = ['compact', 'normal', 'detailed'];
const BOARD_GROUPS: BoardGroupBy[] = ['none', 'assignee', 'priority', 'epic'];

function readLocalStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded / privacy-mode - ignore.
  }
}

function useLocalState<T extends string>(
  key: string | null,
  fallback: T,
  validate: (raw: string) => T | null,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    if (!key) return;
    const raw = readLocalStorage(key);
    const parsed = raw ? validate(raw) : null;
    setValue(parsed ?? fallback);
    // We deliberately ignore `fallback` changes - the storage value is the truth
    // once it exists; fallback only matters on first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (key) writeLocalStorage(key, next);
    },
    [key],
  );
  return [value, set];
}

export function useBoardDensity(): {
  density: BoardDensity;
  setDensity: (next: BoardDensity) => void;
} {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const key = userId ? `board-density:${userId}` : null;
  const [density, setDensity] = useLocalState<BoardDensity>(key, DENSITY_DEFAULT, (raw) =>
    DENSITIES.includes(raw as BoardDensity) ? (raw as BoardDensity) : null,
  );
  return { density, setDensity };
}

export function useBoardGroupBy(projectId: string): {
  groupBy: BoardGroupBy;
  setGroupBy: (next: BoardGroupBy) => void;
} {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const key = userId ? `board-groupby:${userId}:${projectId}` : null;
  const [groupBy, setGroupBy] = useLocalState<BoardGroupBy>(key, 'none', (raw) =>
    BOARD_GROUPS.includes(raw as BoardGroupBy) ? (raw as BoardGroupBy) : null,
  );
  return { groupBy, setGroupBy };
}

const LIST_GROUPS: ListGroupBy[] = ['none', 'status', 'assignee', 'priority', 'sprint'];

export function useListGroupBy(projectId: string): {
  groupBy: ListGroupBy;
  setGroupBy: (next: ListGroupBy) => void;
} {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const key = userId ? `list-groupby:${userId}:${projectId}` : null;
  const [groupBy, setGroupBy] = useLocalState<ListGroupBy>(key, 'status', (raw) =>
    LIST_GROUPS.includes(raw as ListGroupBy) ? (raw as ListGroupBy) : null,
  );
  return { groupBy, setGroupBy };
}

type BuiltInListColumn =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'due'
  | 'updated'
  | 'description'
  | 'sprint'
  | 'estimate';

/** A built-in column, or `cf:<definitionId>` for a task custom field. */
export type ListColumn = BuiltInListColumn | `cf:${string}`;

const CUSTOM_FIELD_PREFIX = 'cf:';

export function customFieldColumn(definitionId: string): ListColumn {
  return `${CUSTOM_FIELD_PREFIX}${definitionId}`;
}

/** The definition id of a custom-field column, or null for a built-in one. */
export function customFieldIdOf(column: ListColumn): string | null {
  return column.startsWith(CUSTOM_FIELD_PREFIX) ? column.slice(CUSTOM_FIELD_PREFIX.length) : null;
}

export const DEFAULT_LIST_COLUMNS: ListColumn[] = [
  'status',
  'priority',
  'assignee',
  'due',
  'updated',
];

export const ALL_LIST_COLUMNS: { id: BuiltInListColumn; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'due', label: 'Due' },
  { id: 'updated', label: 'Updated' },
  { id: 'description', label: 'Description' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'estimate', label: 'Estimate' },
];

const COLUMN_IDS = new Set<string>(ALL_LIST_COLUMNS.map((c) => c.id));

/**
 * A stored column id that is still valid: a built-in, or any custom-field
 * column (one whose field was deleted since is simply not rendered).
 */
export function isListColumn(value: unknown): value is ListColumn {
  if (typeof value !== 'string') return false;
  if (COLUMN_IDS.has(value)) return true;
  return /^cf:[a-z0-9]+$/i.test(value);
}

export function useListColumns(projectId: string): {
  columns: ListColumn[];
  setColumns: (next: ListColumn[]) => void;
} {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const key = userId ? `list-columns:${userId}:${projectId}` : null;
  const [columns, setColumns] = useState<ListColumn[]>(DEFAULT_LIST_COLUMNS);
  useEffect(() => {
    if (!key) return;
    const raw = readLocalStorage(key);
    if (!raw) {
      setColumns(DEFAULT_LIST_COLUMNS);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every(isListColumn)
      ) {
        setColumns(parsed as ListColumn[]);
        return;
      }
    } catch {
      // Fall through.
    }
    setColumns(DEFAULT_LIST_COLUMNS);
  }, [key]);
  const setAndPersist = useCallback(
    (next: ListColumn[]) => {
      setColumns(next);
      if (key) writeLocalStorage(key, JSON.stringify(next));
    },
    [key],
  );
  return { columns, setColumns: setAndPersist };
}
