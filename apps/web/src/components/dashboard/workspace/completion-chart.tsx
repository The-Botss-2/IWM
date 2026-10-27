'use client';

import { BarChart3 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { CHART_COLORS } from '@/components/dashboard/workspace/colors';
import { WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useWeeklyCompletion } from '@/hooks/use-workspace-task-stats';

const WEEKS_BACK = 8;

/**
 * Two-series bar chart: tasks completed and todos completed per week, last
 * 8 ISO weeks, or across the dashboard's date range when one is set. Bucketing is client-side off the workspace-scoped task /
 * todo lists - keeps the work within the existing API surface.
 */
export function WeeklyCompletionChartWidget() {
  const { data, isLoading: loading, isError, refetch, granularity, rangeLabel, truncated } =
    useWeeklyCompletion(WEEKS_BACK);
  const title =
    granularity === 'day'
      ? 'Daily completion'
      : granularity === 'month'
        ? 'Monthly completion'
        : 'Weekly completion';
  const empty =
    !loading && data.every((b) => b.tasks === 0 && b.todos === 0);

  return (
    <WidgetShell
      id="widget-ws-completion"
      title={title}
      subtitle={rangeLabel}
      icon={BarChart3}
    >
      {loading ? (
        <Skeleton className="h-44 w-full" />
      ) : isError ? (
        <QueryError compact message="Couldn't load completions." onRetry={refetch} />
      ) : empty ? (
        <div className="grid h-44 place-items-center text-xs text-ink-muted">
          {rangeLabel
            ? `No completions in ${rangeLabel}.`
            : `No completions in the last ${WEEKS_BACK} weeks.`}
        </div>
      ) : (
        <>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                barCategoryGap={12}
              >
                <defs>
                  <linearGradient id="ws-comp-tasks" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.purple} />
                    <stop offset="100%" stopColor={CHART_COLORS.magenta} />
                  </linearGradient>
                  <linearGradient id="ws-comp-todos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.orange} />
                    <stop offset="100%" stopColor={CHART_COLORS.magenta} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke={CHART_COLORS.line}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11 }}
                  allowDecimals={false}
                  width={32}
                />
                <Tooltip
                  cursor={{ fill: CHART_COLORS.bgSubtle }}
                  contentStyle={{
                    background: 'white',
                    border: `1px solid ${CHART_COLORS.line}`,
                    borderRadius: 8,
                    fontSize: 12,
                    boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
                  }}
                  labelStyle={{ color: CHART_COLORS.ink, fontWeight: 600 }}
                />
                <Bar
                  dataKey="tasks"
                  name="Tasks"
                  radius={[6, 6, 0, 0]}
                  fill="url(#ws-comp-tasks)"
                >
                  {data.map((d) => (
                    <Cell key={`t-${d.weekStart}`} fill="url(#ws-comp-tasks)" />
                  ))}
                </Bar>
                <Bar
                  dataKey="todos"
                  name="Todos"
                  radius={[6, 6, 0, 0]}
                  fill="url(#ws-comp-todos)"
                >
                  {data.map((d) => (
                    <Cell key={`d-${d.weekStart}`} fill="url(#ws-comp-todos)" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-ink-muted">
            <LegendDot color={CHART_COLORS.purple} label="Tasks" />
            <LegendDot color={CHART_COLORS.orange} label="Todos" />
          </div>
          {truncated ? (
            <p className="mt-2 text-xs text-ink-muted">
              Partial data: this range has more completed tasks than the chart loads. Pick a
              shorter range for full counts.
            </p>
          ) : null}
        </>
      )}
    </WidgetShell>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

