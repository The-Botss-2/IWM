'use client';

import { KanbanSquare, List } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const LEAD_VIEWS = ['pipeline', 'list'] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

export const DEFAULT_LEAD_VIEW: LeadView = 'pipeline';

export function parseLeadView(value: string | null | undefined): LeadView {
  if (!value) return DEFAULT_LEAD_VIEW;
  return (LEAD_VIEWS as readonly string[]).includes(value)
    ? (value as LeadView)
    : DEFAULT_LEAD_VIEW;
}

const ICONS: Record<LeadView, typeof KanbanSquare> = {
  pipeline: KanbanSquare,
  list: List,
};

const LABELS: Record<LeadView, string> = {
  pipeline: 'Pipeline',
  list: 'List',
};

export function useLeadView(): { view: LeadView; setView: (next: LeadView) => void } {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseLeadView(params.get('view'));
  const setView = useCallback(
    (next: LeadView) => {
      const sp = new URLSearchParams(params.toString());
      if (next === DEFAULT_LEAD_VIEW) sp.delete('view');
      else sp.set('view', next);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [params, router],
  );
  return { view, setView };
}

export function LeadViewTabs({
  view,
  onChange,
}: {
  view: LeadView;
  onChange: (next: LeadView) => void;
}) {
  return (
    <Tabs value={view} onValueChange={(v) => onChange(v as LeadView)}>
      <TabsList className="-mx-1 px-1 w-full sm:w-auto">
        {LEAD_VIEWS.map((v) => {
          const Icon = ICONS[v];
          return (
            <TabsTrigger key={v} value={v}>
              <Icon className="h-4 w-4" aria-hidden />
              <span>{LABELS[v]}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
