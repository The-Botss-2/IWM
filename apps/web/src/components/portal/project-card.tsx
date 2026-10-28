import Link from 'next/link';
import type { PortalProjectSummary } from '@botss/shared-types';

import { formatDate, tasksDoneLabel } from '@/components/portal/format';
import { ProjectStatusBadge } from '@/components/portal/portal-badges';
import { portalProjectHref } from '@/hooks/use-portal';
import { cn } from '@/lib/utils';

/** Done over total, as a bar. The same figure staff see on the project summary. */
export function PortalProgressBar({
  percent,
  label,
  className,
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn('bg-bg-subtle h-2 w-full overflow-hidden rounded-full', className)}
    >
      <div className="bg-brand-gradient h-full rounded-full" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * A project at a glance, linking to its detail page. `headingLevel` keeps
 * the outline in order: h2 straight under a page title, h3 under a section.
 */
export function PortalProjectCard({
  clientId,
  project,
  headingLevel = 'h3',
}: {
  clientId: string;
  project: PortalProjectSummary;
  headingLevel?: 'h2' | 'h3';
}) {
  const { progress } = project;
  const Heading = headingLevel;
  return (
    <Link
      href={portalProjectHref(clientId, project.id)}
      className="card hover:shadow-soft-lg focus-visible:ring-brand-purple/50 flex h-full flex-col gap-4 p-5 transition-shadow duration-200 focus-visible:outline-none focus-visible:ring-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {project.color ? (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          <Heading className="text-ink truncate text-base font-semibold">{project.name}</Heading>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>
      <div className="mt-auto space-y-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-ink-muted">{tasksDoneLabel(progress.done, progress.total)}</span>
          <span className="text-ink font-semibold tabular-nums">{progress.percent}%</span>
        </div>
        <PortalProgressBar percent={progress.percent} label={`${project.name} progress`} />
        {project.dueDate ? (
          <p className="text-ink-muted text-xs">Due {formatDate(project.dueDate)}</p>
        ) : null}
      </div>
    </Link>
  );
}
