'use client';

import { Check } from 'lucide-react';
import { use } from 'react';
import type {
  MilestoneStatus,
  PortalMilestone,
  PortalProgress,
  PortalTask,
} from '@botss/shared-types';

import {
  dateRangeLabel,
  milestoneDateLabel,
  plural,
  taskDateLabel,
  tasksDoneLabel,
} from '@/components/portal/format';
import {
  MilestoneStatusBadge,
  PaymentStatusBadge,
  ProjectStatusBadge,
  TaskStatusBadge,
} from '@/components/portal/portal-badges';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { PortalUnavailable } from '@/components/portal/portal-states';
import { PortalProgressBar } from '@/components/portal/project-card';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  portalErrorStatus,
  portalHref,
  useOrderedPortalTasks,
  usePortalProject,
} from '@/hooks/use-portal';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

export default function PortalProjectPage({
  params,
}: {
  params: Promise<{ clientId: string; projectId: string }>;
}) {
  const { clientId, projectId } = use(params);
  const project = usePortalProject(clientId, projectId);
  const tasks = useOrderedPortalTasks(project.data?.tasks);
  const back = { href: portalHref(clientId, 'projects'), label: 'Projects' };

  if (project.isLoading) return <ProjectSkeleton />;

  if (project.isError || !project.data) {
    if (portalErrorStatus(project.error) === 404) {
      return (
        <PortalUnavailable
          title="This project isn't available"
          description="It may have been removed, or it is no longer shared with you."
          href={back.href}
          linkLabel="Back to projects"
        />
      );
    }
    return (
      <div className="space-y-6">
        <PortalPageHeader back={back} title="Project" />
        <QueryError message="Couldn't load this project." onRetry={() => void project.refetch()} />
      </div>
    );
  }

  const p = project.data;
  const dates = dateRangeLabel(p.startDate, p.dueDate);
  const hasMilestones = p.milestones.length > 0;

  return (
    <div className="space-y-6">
      <PortalPageHeader
        back={back}
        title={p.name}
        meta={
          <>
            <ProjectStatusBadge status={p.status} />
            {dates ? <span>{dates}</span> : null}
          </>
        }
      />

      <ProgressSection progress={p.progress} />

      <div className={cn('grid gap-6', hasMilestones && 'lg:grid-cols-3 lg:items-start')}>
        {hasMilestones ? (
          <section
            aria-labelledby="project-milestones"
            className="card p-5 sm:p-6 lg:order-2 lg:col-span-1"
          >
            <h2 id="project-milestones" className="text-ink text-base font-semibold">
              Milestones
            </h2>
            <MilestoneTimeline milestones={p.milestones} />
          </section>
        ) : null}

        <section
          aria-labelledby="project-tasks"
          className={cn('card p-5 sm:p-6', hasMilestones && 'lg:order-1 lg:col-span-2')}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="project-tasks" className="text-ink text-base font-semibold">
              {p.taskMode === 'MARKED' ? 'Tasks your team has shared with you' : 'All tasks'}
            </h2>
            {tasks.length > 0 ? (
              <span className="text-ink-muted shrink-0 text-sm tabular-nums">
                {tasks.length} {plural(tasks.length, 'task', 'tasks')}
              </span>
            ) : null}
          </div>
          {tasks.length === 0 ? (
            <p className="text-ink-muted mt-3 text-sm">
              {p.taskMode === 'MARKED'
                ? "Your team hasn't shared individual tasks yet."
                : 'There are no tasks on this project yet.'}
            </p>
          ) : (
            <TaskList tasks={tasks} />
          )}
        </section>
      </div>
    </div>
  );
}

function ProgressSection({ progress }: { progress: PortalProgress }) {
  const stats = [
    { label: 'Not started', value: progress.notStarted },
    { label: 'In progress', value: progress.inProgress },
    { label: 'In review', value: progress.inReview },
    { label: 'Done', value: progress.done },
  ];
  return (
    <section aria-labelledby="project-progress" className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="project-progress" className="text-ink-muted text-sm font-medium">
            Progress
          </h2>
          <p className="text-ink mt-1 text-3xl font-bold tabular-nums">{progress.percent}%</p>
        </div>
        <p className="text-ink-muted text-sm">{tasksDoneLabel(progress.done, progress.total)}</p>
      </div>
      <PortalProgressBar className="mt-4" percent={progress.percent} label="Project progress" />
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="text-ink-muted text-xs">{stat.label}</dt>
            <dd className="text-ink mt-0.5 text-lg font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {progress.cancelled > 0 ? (
        <p className="text-ink-muted mt-4 text-xs">
          The total includes {progress.cancelled} cancelled{' '}
          {plural(progress.cancelled, 'task', 'tasks')}.
        </p>
      ) : null}
    </section>
  );
}

function MilestoneTimeline({ milestones }: { milestones: PortalMilestone[] }) {
  return (
    <ol className="mt-4">
      {milestones.map((m, i) => {
        const dates = milestoneDateLabel(m);
        return (
          <li key={m.id} className="relative pb-6 pl-7 last:pb-0">
            {i < milestones.length - 1 ? (
              <span
                aria-hidden
                className="bg-line absolute bottom-0 left-[7px] top-[1.125rem] w-px"
              />
            ) : null}
            <MilestoneMarker status={m.status} />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-ink text-sm font-medium">{m.title}</h3>
              <MilestoneStatusBadge status={m.status} />
            </div>
            {dates ? <p className="text-ink-muted mt-1 text-xs">{dates}</p> : null}
            {m.amount !== null && m.currency !== null ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-ink text-sm tabular-nums">
                  {formatCurrency(m.amount, m.currency)}
                </span>
                {m.paymentStatus ? <PaymentStatusBadge status={m.paymentStatus} /> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function MilestoneMarker({ status }: { status: MilestoneStatus }) {
  if (status === 'DELIVERED') {
    return (
      <span
        aria-hidden
        className="bg-brand-purple absolute left-0 top-0.5 grid h-4 w-4 place-items-center rounded-full text-white"
      >
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'bg-bg-surface absolute left-0 top-0.5 h-4 w-4 rounded-full border-2',
        status === 'IN_PROGRESS' ? 'border-brand-purple' : 'border-line-strong',
      )}
    />
  );
}

function TaskList({ tasks }: { tasks: PortalTask[] }) {
  return (
    <ul className="divide-line mt-3 divide-y">
      {tasks.map((task) => {
        const date = taskDateLabel(task);
        return (
          <li
            key={task.id}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <p
              className={cn(
                'min-w-0 flex-1 text-sm',
                task.status === 'DONE' ? 'text-ink-muted' : 'text-ink',
              )}
            >
              {task.title}
            </p>
            <div className="flex shrink-0 items-center gap-3">
              <TaskStatusBadge status={task.status} />
              <span className="text-ink-muted text-xs tabular-nums sm:w-36 sm:text-right">
                {date}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-5 w-48" />
      </div>
      <Skeleton className="h-44 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
