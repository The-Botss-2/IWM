'use client';

import { CheckCircle2, Clock, Flag, Users } from 'lucide-react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { useProjectSummary } from '@/hooks/use-project-summary';
import { absoluteTime, relativeTime } from '@/lib/time';

const STATUS_COLOR: Record<string, string> = {
  BACKLOG: '#94a3b8',
  TODO: '#60a5fa',
  IN_PROGRESS: '#fbbf24',
  IN_REVIEW: '#a78bfa',
  DONE: '#34d399',
  CANCELLED: '#cbd5e1',
};

export default function SummaryView({ projectId }: { projectId: string }) {
  const summary = useProjectSummary(projectId);
  if (summary.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  if (summary.isError || !summary.data) {
    return <p className="text-sm text-state-error">Couldn&apos;t load summary.</p>;
  }
  const s = summary.data;
  const completion = s.totals.tasks > 0 ? Math.round((s.totals.done / s.totals.tasks) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Progress"
          value={`${completion}%`}
          sub={`${s.totals.done} / ${s.totals.tasks} done`}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="In progress"
          value={String(s.totals.inProgress)}
        />
        <StatCard
          icon={<Flag className="h-4 w-4" />}
          label="Overdue"
          value={String(s.totals.overdue)}
          tone={s.totals.overdue > 0 ? 'danger' : 'normal'}
        />
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Active sprint"
          value={s.activeSprint ? s.activeSprint.name : 'None'}
          sub={
            s.activeSprint
              ? `${s.activeSprint.taskCount} tasks · ends ${relativeTime(s.activeSprint.endDate)}`
              : 'No sprint started'
          }
        />
      </div>

      {s.upcomingDeadline ? (
        <div className="rounded-lg border border-brand-orange/30 bg-brand-orange/15 p-4">
          <div className="text-xs uppercase tracking-wide text-brand-orange">Upcoming deadline</div>
          <div className="mt-1 text-sm font-medium text-brand-orange">
            <Link href={`?view=board`} className="hover:underline">
              {s.upcomingDeadline.title}
            </Link>{' '}
            <span className="text-xs text-brand-orange" title={absoluteTime(s.upcomingDeadline.dueDate)}>
              · {relativeTime(s.upcomingDeadline.dueDate)}
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Tasks by status">
          <Donut
            data={s.byStatus.map((b) => ({
              label: b.status,
              value: b.count,
              color: STATUS_COLOR[b.status] ?? '#64748b',
            }))}
          />
        </ChartCard>
        <ChartCard title="Tasks by assignee">
          <HorizontalBars
            data={s.byAssignee.slice(0, 8).map((b) => ({
              label: b.user?.name || b.user?.email || 'Unassigned',
              value: b.count,
            }))}
          />
        </ChartCard>
      </div>

      <ChartCard title="Recent activity">
        {s.recentActivity.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {s.recentActivity.slice(0, 10).map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                <span className="truncate">{a.title}</span>
                <span
                  className="ml-3 shrink-0 text-xs text-ink-muted"
                  title={absoluteTime(a.at)}
                >
                  {relativeTime(a.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ChartCard>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = 'normal',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: 'normal' | 'danger';
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === 'danger' ? 'border-state-error/30 bg-state-error/15' : 'border-line bg-bg-surface'
      }`}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-ink-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub ? <div className="text-xs text-ink-muted">{sub}</div> : null}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Tiny inline SVG donut chart - no external chart lib. */
function Donut({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return <p className="text-sm text-ink-muted">No data yet.</p>;
  }
  let acc = 0;
  const radius = 60;
  const stroke = 18;
  const c = 2 * Math.PI * radius;
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 160 160" className="h-40 w-40 -rotate-90" aria-hidden>
        <circle cx={80} cy={80} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
        {data.map((d) => {
          const len = (d.value / total) * c;
          const seg = (
            <circle
              key={d.label}
              cx={80}
              cy={80}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-acc}
            />
          );
          acc += len;
          return seg;
        })}
      </svg>
      <ul className="space-y-1 text-xs">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: d.color }}
              aria-hidden
            />
            <span className="text-ink">{d.label}</span>
            <span className="ml-auto font-mono text-ink-muted">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HorizontalBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) {
    return <p className="text-sm text-ink-muted">No data yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.label} className="text-xs">
          <div className="flex justify-between text-ink">
            <span className="truncate">{d.label}</span>
            <span className="font-mono text-ink-muted">{d.value}</span>
          </div>
          <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-bg-subtle">
            <div
              className="h-full bg-[#EAF0FC]0"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
