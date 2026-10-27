import type {
  SprintWithStats,
  TaskWithPeople,
} from '@botss/shared-types';

import { customFieldIdOf, type ListColumn } from '@/hooks/use-board-prefs';
import {
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { saveFile } from '@/lib/save-file';

const COLUMN_HEADERS: Record<ListColumn | 'title', string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  due: 'Due',
  updated: 'Updated',
  description: 'Description',
  sprint: 'Sprint',
  estimate: 'Estimate (h)',
};

function escape(value: unknown): string {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function isoOrEmpty(d: Date | null | undefined): string {
  return d ? d.toISOString() : '';
}

/**
 * Build a CSV string from the currently visible tasks and columns. Title is
 * always included as the first column so a downstream pivot has a stable key.
 */
export function buildTasksCsv(
  tasks: TaskWithPeople[],
  columns: ListColumn[],
  sprints: SprintWithStats[],
): string {
  // Custom-field columns are on-screen only; the export keeps the task's own
  // fields.
  const ordered: (ListColumn | 'title')[] = [
    'title',
    ...columns.filter((c) => customFieldIdOf(c) === null),
  ];
  const taskToSprint = new Map<string, string>();
  for (const s of sprints) for (const tid of s.taskIds) taskToSprint.set(tid, s.name);

  const header = ordered.map((c) => escape(COLUMN_HEADERS[c])).join(',');
  const rows = tasks.map((t) =>
    ordered
      .map((c) => {
        switch (c) {
          case 'title':
            return escape(t.title);
          case 'status':
            return escape(statusLabel(t.status));
          case 'priority':
            return escape(priorityLabel(t.priority));
          case 'assignee':
            return escape(t.assignee?.name ?? t.assignee?.email ?? '');
          case 'due':
            return escape(isoOrEmpty(t.dueDate));
          case 'updated':
            return escape(isoOrEmpty(t.updatedAt));
          case 'description':
            return escape(t.description ?? '');
          case 'sprint':
            return escape(taskToSprint.get(t.id) ?? '');
          case 'estimate':
            return escape(t.estimateHours ?? '');
          default:
            return '';
        }
      })
      .join(','),
  );
  return [header, ...rows].join('\r\n');
}

/** Trigger a client-side download of the supplied CSV text.
 *
 *  Fire-and-forget: `saveFile` is async because the native-shell path has to
 *  base64 the blob, but every caller here is a button handler with nothing to
 *  await. Errors are surfaced by `saveFile` itself or, in the browser path,
 *  cannot occur. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;
  // BOM gives Excel a chance at correctly detecting UTF-8.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  void saveFile(blob, filename);
}

export function csvFilename(projectKey: string): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${projectKey}-tasks-${y}${m}${day}.csv`;
}
