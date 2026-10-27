'use client';

import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import type { TimeEntryWithMeta } from '@botss/shared-types';

import { ShareToChatDialog } from '@/components/chat/share-to-chat-dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  usePauseTimer,
  useResumeTimer,
  useStartTimer,
  useStopTimer,
  useTimesheetProjectOptions,
  useTimesheetSummary,
  useTimesheetTaskOptions,
  useTimesheets,
  useUpdateTimeEntry,
} from '@/hooks/use-timesheets';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { absoluteTime } from '@/lib/time';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}
function fmtRange(start: Date, end: Date): string {
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function TimesheetsPage() {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);
  const [manualOpen, setManualOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const running = useTimesheets({ running: true });
  const weekly = useTimesheets({ from: weekStart, to: weekEnd });
  const summary = useTimesheetSummary({ from: weekStart, to: weekEnd });
  // Stop / Pause / Resume controls live inside ActiveTimerBanner - the
  // parent no longer needs to forward mutations down by prop.
  const remove = useDeleteTimeEntry();
  const [shareTarget, setShareTarget] = useState<
    { id: string; label: string } | null
  >(null);
  const [editTarget, setEditTarget] = useState<TimeEntryWithMeta | null>(null);

  const runningEntry = running.data?.items[0] ?? null;

  return (
    <div className="mx-auto h-[var(--app-content-h,calc(100vh-4rem))] w-full max-w-6xl overflow-y-auto px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Timesheets</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Track time per project and task. Manual entries are billable by default.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary">
            <Link href="/timesheets/leave">
              <CalendarRange className="h-4 w-4" />
              Time off
            </Link>
          </Button>
          <Button
            id="timesheet-manual-toggle"
            variant="secondary"
            onClick={() => setManualOpen((v) => !v)}
          >
            <Plus className="h-4 w-4" />
            {manualOpen ? 'Hide manual entry' : 'Add manual entry'}
          </Button>
        </div>
      </header>

      {runningEntry ? (
        <ActiveTimerBanner entry={runningEntry} />
      ) : (
        <StartTimerCard />
      )}

      {manualOpen ? (
        <ManualEntryForm onClose={() => setManualOpen(false)} />
      ) : null}

      <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <WeeklyTable
          weekStart={weekStart}
          weekEnd={weekEnd}
          entries={weekly.data?.items ?? []}
          loading={weekly.isLoading}
          error={weekly.isError}
          onRetry={() => void weekly.refetch()}
          onPrev={() => setWeekStart((d) => addDays(d, -7))}
          onNext={() => setWeekStart((d) => addDays(d, 7))}
          onToday={() => setWeekStart(startOfWeek(new Date()))}
          onDelete={(id) => setDeleteTarget(id)}
          onShare={(id, label) => setShareTarget({ id, label })}
          onEdit={(entry) => setEditTarget(entry)}
        />
        <SummarySidebar
          totalMinutes={summary.data?.totalMinutes ?? 0}
          byProject={summary.data?.byProject ?? []}
          loading={summary.isLoading}
          error={summary.isError}
          onRetry={() => void summary.refetch()}
        />
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete this entry?"
        description="The hours will no longer count toward the weekly total."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await remove.mutateAsync(deleteTarget);
            setDeleteTarget(null);
          } catch {
            // Toast raised by the hook; keep the dialog open.
          }
        }}
      />

      {shareTarget ? (
        <ShareToChatDialog
          open={shareTarget !== null}
          onOpenChange={(next) => {
            if (!next) setShareTarget(null);
          }}
          itemType="timesheet"
          itemId={shareTarget.id}
          itemLabel={shareTarget.label}
        />
      ) : null}

      {editTarget ? (
        <EditTimeEntryDialog
          entry={editTarget}
          onClose={() => setEditTarget(null)}
        />
      ) : null}
    </div>
  );
}

function useElapsedMinutes(start: Date): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - start.getTime()) / 60_000));
}

function ActiveTimerBanner({ entry }: { entry: TimeEntryWithMeta }) {
  const stop = useStopTimer();
  const pause = usePauseTimer();
  const resume = useResumeTimer();
  const isPaused = !!entry.pausedAt;
  // Elapsed = gross - accumulator - (open pause, if currently paused). The
  // gross ticks via useElapsedMinutes; both adjusters are constant within a
  // render so the subtraction stays cheap.
  const gross = useElapsedMinutes(entry.startTime);
  const openPause = useElapsedMinutes(entry.pausedAt ?? new Date(0));
  const netMinutes = Math.max(
    0,
    gross - entry.accumulatedPauseMin - (entry.pausedAt ? openPause : 0),
  );
  const label =
    entry.task?.title ||
    entry.taskLabel ||
    entry.project?.name ||
    entry.projectLabel ||
    entry.description ||
    'Tracked time';
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors',
        isPaused
          ? 'border-brand-orange/30 bg-tint-warning'
          : 'border-brand-teal/30 bg-tint-info',
      )}
    >
      <div className="min-w-0">
        <div
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
            isPaused ? 'text-brand-orange' : 'text-brand-teal',
          )}
        >
          {isPaused ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {isPaused ? 'Timer paused' : 'Timer running'}
        </div>
        <div className="mt-0.5 truncate text-sm font-medium text-ink">{label}</div>
        <div className="mt-0.5 text-xs text-ink-muted">
          Since {fmtTime(entry.startTime)} · {fmtMinutes(netMinutes)} elapsed
          {entry.accumulatedPauseMin > 0
            ? ` · ${entry.accumulatedPauseMin}m paused`
            : ''}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isPaused ? (
          <Button
            id="timesheet-resume"
            onClick={() => resume.mutate(entry.id)}
            disabled={resume.isPending}
            className="bg-brand-gradient"
          >
            <Play className="h-4 w-4" />
            Resume
          </Button>
        ) : (
          <Button
            id="timesheet-pause"
            variant="secondary"
            onClick={() => pause.mutate(entry.id)}
            disabled={pause.isPending}
          >
            <Pause className="h-4 w-4" />
            Pause
          </Button>
        )}
        <Button
          id="timesheet-stop"
          onClick={() => stop.mutate(entry.id)}
          disabled={stop.isPending}
          className="bg-state-error hover:bg-state-error"
        >
          <Square className="h-4 w-4" />
          Stop
        </Button>
      </div>
    </div>
  );
}

function StartTimerCard() {
  const projects = useTimesheetProjectOptions();
  const tasks = useTimesheetTaskOptions();
  const [projectInput, setProjectInput] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const start = useStartTimer();

  /**
   * Resolve the typed project/task text against the existing rows. An
   * exact case-insensitive match wins (so a user typing the name of a
   * known project gets the FK, not a duplicate free-text label). Anything
   * else falls through as a label-only entry.
   */
  const matchedProject = useMemo(
    () => matchByName(projects, projectInput),
    [projects, projectInput],
  );
  const tasksForProject = useMemo(() => {
    if (!matchedProject) return [];
    return tasks.filter((t) => t.projectId === matchedProject.id);
  }, [tasks, matchedProject]);
  const matchedTask = useMemo(
    () => matchByTitle(tasksForProject, taskInput),
    [tasksForProject, taskInput],
  );

  function go(): void {
    const projectName = projectInput.trim();
    const taskTitle = taskInput.trim();
    start.mutate(
      {
        ...(matchedProject
          ? { projectId: matchedProject.id }
          : projectName
            ? { projectLabel: projectName }
            : {}),
        ...(matchedTask
          ? { taskId: matchedTask.id }
          : taskTitle
            ? { taskLabel: taskTitle }
            : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        billable,
      },
      {
        onSuccess: () => {
          setDescription('');
          setProjectInput('');
          setTaskInput('');
          toast.success('Timer started.');
        },
      },
    );
  }

  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <Pause className="h-4 w-4 text-ink-muted" />
        No timer running
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="timer-project">Project</Label>
          <Input
            id="timer-project"
            list="timer-project-list"
            value={projectInput}
            onChange={(e) => {
              setProjectInput(e.target.value);
              // Clear the typed task if the project changes - picking from
              // the suggestions otherwise leaves a stale task name behind.
              setTaskInput('');
            }}
            placeholder="Pick or type a project"
            maxLength={120}
            autoComplete="off"
          />
          <datalist id="timer-project-list">
            {projects.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor="timer-task">Task</Label>
          <Input
            id="timer-task"
            list="timer-task-list"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            placeholder="Pick or type a task"
            maxLength={200}
            autoComplete="off"
          />
          <datalist id="timer-task-list">
            {tasksForProject.map((t) => (
              <option key={t.id} value={t.title} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor="timer-description">Description</Label>
          <Input
            id="timer-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you working on?"
          />
        </div>
        <Button id="timesheet-start" onClick={go} disabled={start.isPending}>
          <Play className="h-4 w-4" />
          Start
        </Button>
      </div>
      <label className="mt-3 inline-flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={billable}
          onChange={(e) => setBillable(e.target.checked)}
          className="h-3.5 w-3.5 accent-emerald-600"
        />
        Billable
      </label>
    </div>
  );
}

function ManualEntryForm({ onClose }: { onClose: () => void }) {
  const projects = useTimesheetProjectOptions();
  const tasks = useTimesheetTaskOptions();
  const create = useCreateTimeEntry();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('10:00');
  const [projectInput, setProjectInput] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);

  const matchedProject = useMemo(
    () => matchByName(projects, projectInput),
    [projects, projectInput],
  );
  const tasksForProject = useMemo(() => {
    if (!matchedProject) return [];
    return tasks.filter((t) => t.projectId === matchedProject.id);
  }, [tasks, matchedProject]);
  const matchedTask = useMemo(
    () => matchByTitle(tasksForProject, taskInput),
    [tasksForProject, taskInput],
  );

  function submit(e: FormEvent): void {
    e.preventDefault();
    const range = buildEntryRange(date, from, to);
    if (!range) {
      toastErrorMessage('Start and end times can’t be identical');
      return;
    }
    const { start, end } = range;
    const projectName = projectInput.trim();
    const taskTitle = taskInput.trim();
    create.mutate(
      {
        startTime: start,
        endTime: end,
        billable,
        ...(matchedProject
          ? { projectId: matchedProject.id }
          : projectName
            ? { projectLabel: projectName }
            : {}),
        ...(matchedTask
          ? { taskId: matchedTask.id }
          : taskTitle
            ? { taskLabel: taskTitle }
            : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Entry saved.');
          onClose();
        },
        onError: (err) => toastError(err, "Couldn't save entry"),
      },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 rounded-lg border border-line bg-white p-4"
    >
      <h2 className="mb-3 text-sm font-semibold text-ink">Manual entry</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="manual-date">Date</Label>
          <Input
            id="manual-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="manual-from">From</Label>
          <Input
            id="manual-from"
            type="time"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="manual-to">To</Label>
          <Input
            id="manual-to"
            type="time"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="manual-project">Project</Label>
          <Input
            id="manual-project"
            list="manual-project-list"
            value={projectInput}
            onChange={(e) => {
              setProjectInput(e.target.value);
              setTaskInput('');
            }}
            placeholder="Pick or type a project"
            maxLength={120}
            autoComplete="off"
          />
          <datalist id="manual-project-list">
            {projects.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor="manual-task">Task</Label>
          <Input
            id="manual-task"
            list="manual-task-list"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            placeholder="Pick or type a task"
            maxLength={200}
            autoComplete="off"
          />
          <datalist id="manual-task-list">
            {tasksForProject.map((t) => (
              <option key={t.id} value={t.title} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1 sm:col-span-3">
          <Label htmlFor="manual-desc">Description</Label>
          <Textarea
            id="manual-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What did you work on?"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-600"
          />
          Billable
        </label>
        <div className="flex gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Save entry
          </Button>
        </div>
      </div>
    </form>
  );
}

function WeeklyTable({
  weekStart,
  weekEnd,
  entries,
  loading,
  error,
  onRetry,
  onPrev,
  onNext,
  onToday,
  onDelete,
  onShare,
  onEdit,
}: {
  weekStart: Date;
  weekEnd: Date;
  entries: TimeEntryWithMeta[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onDelete: (id: string) => void;
  onShare: (id: string, label: string) => void;
  onEdit: (entry: TimeEntryWithMeta) => void;
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntryWithMeta[]>();
    for (const d of days) m.set(d.toDateString(), []);
    for (const e of entries) {
      const key = e.startTime.toDateString();
      const arr = m.get(key);
      if (arr) arr.push(e);
    }
    return m;
  }, [days, entries]);
  const totalMin = entries.reduce((acc, e) => acc + (e.durationMin ?? 0), 0);
  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous week"
            onClick={onPrev}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="secondary" onClick={onToday}>
            This week
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next week"
            onClick={onNext}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 text-sm font-medium text-ink">
            {fmtRange(weekStart, addDays(weekEnd, -1))}
          </span>
        </div>
        <span className="text-xs text-ink-muted">
          Total: <span className="font-semibold text-ink">{fmtMinutes(totalMin)}</span>
        </span>
      </header>
      <div className="divide-y divide-line">
        {loading ? (
          <div className="flex justify-center p-6">
            <Loader size="sm" label="Loading" />
          </div>
        ) : error ? (
          <div className="p-4">
            <QueryError onRetry={onRetry} />
          </div>
        ) : (
          days.map((d) => {
            const list = byDay.get(d.toDateString()) ?? [];
            const dayTotal = list.reduce((a, e) => a + (e.durationMin ?? 0), 0);
            return (
              <div key={d.toDateString()} className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    {fmtDay(d)}
                  </div>
                  <div className="text-xs text-ink-muted">
                    {dayTotal > 0 ? fmtMinutes(dayTotal) : '-'}
                  </div>
                </div>
                {list.length === 0 ? (
                  <p className="text-xs text-ink-disabled">No entries.</p>
                ) : (
                  <ul className="space-y-1.5" role="list">
                    {list.map((e) => (
                      <li
                        key={e.id}
                        className="group flex items-center gap-3 rounded-md border border-line px-3 py-1.5 hover:border-line"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: e.project?.color ?? '#cbd5e1',
                          }}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">
                            {e.task?.title ||
                              e.taskLabel ||
                              e.project?.name ||
                              e.projectLabel ||
                              e.description ||
                              'Tracked time'}
                          </div>
                          {e.description && (e.task || e.project) ? (
                            <div className="truncate text-xs text-ink-muted">
                              {e.description}
                            </div>
                          ) : null}
                          <div className="text-[11px] text-ink-muted">
                            {fmtTime(e.startTime)}–
                            {e.endTime ? fmtTime(e.endTime) : 'running'}
                            {!e.billable ? (
                              <span className="ml-1 rounded bg-bg-subtle px-1 text-ink-muted">
                                non-billable
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs font-medium text-ink">
                          {e.durationMin != null ? fmtMinutes(e.durationMin) : '…'}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit entry"
                          onClick={() => onEdit(e)}
                          className="h-7 w-7 text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:text-ink"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Share to chat"
                          onClick={() =>
                            onShare(
                              e.id,
                              e.task?.title ||
                                e.taskLabel ||
                                e.project?.name ||
                                e.projectLabel ||
                                e.description ||
                                'Tracked time',
                            )
                          }
                          className="h-7 w-7 text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:text-brand-teal"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete entry"
                          onClick={() => onDelete(e.id)}
                          className="h-7 w-7 text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:text-state-error"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function SummarySidebar({
  totalMinutes,
  byProject,
  loading,
  error,
  onRetry,
}: {
  totalMinutes: number;
  byProject: { projectId: string | null; projectName: string | null; projectColor: string | null; totalMinutes: number }[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <aside className="rounded-lg border border-line bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">This week</h2>
      <div className="mb-4 text-2xl font-semibold text-ink">
        {fmtMinutes(totalMinutes)}
      </div>
      {loading ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : error ? (
        <QueryError onRetry={onRetry} />
      ) : byProject.length === 0 ? (
        <p className="text-xs text-ink-muted">
          No tracked time yet. Start a timer to get going.
        </p>
      ) : (
        <ul className="space-y-2" role="list">
          {byProject.map((row) => {
            const pct =
              totalMinutes === 0
                ? 0
                : Math.round((row.totalMinutes / totalMinutes) * 100);
            return (
              <li key={row.projectId ?? '__none__'}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: row.projectColor ?? '#cbd5e1',
                      }}
                      aria-hidden
                    />
                    <span className="truncate font-medium text-ink">
                      {row.projectName ?? 'No project'}
                    </span>
                  </span>
                  <span className="text-ink-muted">
                    {fmtMinutes(row.totalMinutes)} · {pct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                  <div
                    className={cn('h-1.5 rounded-full')}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: row.projectColor ?? '#94a3b8',
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/**
 * Edit dialog for an existing time entry. Mirrors the manual-entry
 * form's layout but pre-populated and patched via PATCH /timesheets/:id.
 * Project + task fields use the same combobox-with-datalist pattern as
 * the start/manual cards so freshly-named projects continue to round-trip.
 */
function EditTimeEntryDialog({
  entry,
  onClose,
}: {
  entry: TimeEntryWithMeta;
  onClose: () => void;
}) {
  const projects = useTimesheetProjectOptions();
  const tasks = useTimesheetTaskOptions();
  const update = useUpdateTimeEntry();

  const isoDay = entry.startTime.toISOString().slice(0, 10);
  const initialTo = entry.endTime ?? entry.startTime;
  const [date, setDate] = useState(isoDay);
  const [from, setFrom] = useState(
    entry.startTime.toTimeString().slice(0, 5),
  );
  const [to, setTo] = useState(initialTo.toTimeString().slice(0, 5));
  const [projectInput, setProjectInput] = useState(
    entry.project?.name ?? entry.projectLabel ?? '',
  );
  const [taskInput, setTaskInput] = useState(
    entry.task?.title ?? entry.taskLabel ?? '',
  );
  const [description, setDescription] = useState(entry.description ?? '');
  const [billable, setBillable] = useState(entry.billable);

  const matchedProject = useMemo(
    () => matchByName(projects, projectInput),
    [projects, projectInput],
  );
  const tasksForProject = useMemo(() => {
    if (!matchedProject) return [];
    return tasks.filter((t) => t.projectId === matchedProject.id);
  }, [tasks, matchedProject]);
  const matchedTask = useMemo(
    () => matchByTitle(tasksForProject, taskInput),
    [tasksForProject, taskInput],
  );

  function submit(e: FormEvent): void {
    e.preventDefault();
    const range = buildEntryRange(date, from, to);
    if (!range) {
      toastErrorMessage('Start and end times can’t be identical');
      return;
    }
    const { start, end } = range;
    const projectName = projectInput.trim();
    const taskTitle = taskInput.trim();
    update.mutate(
      {
        id: entry.id,
        input: {
          startTime: start,
          endTime: end,
          billable,
          description: description.trim() === '' ? null : description.trim(),
          // Mutually-exclusive project + task: pass the FK if matched,
          // otherwise the label, otherwise explicitly null to clear.
          projectId: matchedProject ? matchedProject.id : null,
          projectLabel: matchedProject
            ? null
            : projectName === ''
              ? null
              : projectName,
          taskId: matchedTask ? matchedTask.id : null,
          taskLabel: matchedTask ? null : taskTitle === '' ? null : taskTitle,
        },
      },
      {
        onSuccess: () => {
          toast.success('Entry updated.');
          onClose();
        },
        onError: (err) => toastError(err, "Couldn't update entry"),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit time entry</DialogTitle>
          <DialogDescription>
            Adjust the date, range, project, task, or notes for this entry.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3 sm:grid-cols-4" onSubmit={submit}>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="edit-date">Date</Label>
            <Input
              id="edit-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-from">From</Label>
            <Input
              id="edit-from"
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-to">To</Label>
            <Input
              id="edit-to"
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="edit-project">Project</Label>
            <Input
              id="edit-project"
              list="edit-project-list"
              value={projectInput}
              onChange={(e) => {
                setProjectInput(e.target.value);
                setTaskInput('');
              }}
              placeholder="Pick or type a project"
              maxLength={120}
              autoComplete="off"
            />
            <datalist id="edit-project-list">
              {projects.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="edit-task">Task</Label>
            <Input
              id="edit-task"
              list="edit-task-list"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="Pick or type a task"
              maxLength={200}
              autoComplete="off"
            />
            <datalist id="edit-task-list">
              {tasksForProject.map((t) => (
                <option key={t.id} value={t.title} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1 sm:col-span-4">
            <Label htmlFor="edit-desc">Description</Label>
            <Textarea
              id="edit-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What did you work on?"
            />
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-ink-muted sm:col-span-2">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-600"
            />
            Billable
          </label>
          <DialogFooter className="sm:col-span-4">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Build a start/end pair from a single date + two HH:mm time strings.
 * When the user enters an end time that's at or before the start time
 * (e.g. 23:00 → 01:00), we treat the end as the next calendar day. The
 * shared-types schema only requires `endTime > startTime` in absolute
 * terms, so a +24h roll satisfies validation without forcing the user
 * to pick the next day's date manually.
 *
 * Returns `null` when both times are identical - that's a 0-duration
 * entry the caller should reject as nonsense rather than convert into a
 * 24-hour shift.
 */
function buildEntryRange(
  date: string,
  from: string,
  to: string,
): { start: Date; end: Date } | null {
  const start = new Date(`${date}T${from}:00`);
  let end = new Date(`${date}T${to}:00`);
  if (end.getTime() === start.getTime()) return null;
  if (end.getTime() < start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

/** Case-insensitive exact-name match against an option list. */
function matchByName<T extends { id: string; name: string }>(
  list: T[],
  typed: string,
): T | null {
  const t = typed.trim().toLowerCase();
  if (!t) return null;
  return list.find((p) => p.name.toLowerCase() === t) ?? null;
}

function matchByTitle<T extends { id: string; title: string }>(
  list: T[],
  typed: string,
): T | null {
  const t = typed.trim().toLowerCase();
  if (!t) return null;
  return list.find((p) => p.title.toLowerCase() === t) ?? null;
}

