'use client';

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCallback, useMemo, useRef } from 'react';
import type { LeadStage, LeadWithOwner } from '@botss/shared-types';

import {
  SourceBadge,
  STAGE_OPTIONS,
  stageLabel,
} from '@/components/leads/lead-badges';
import { formatCurrency } from '@/lib/money';
import { UserAvatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { useUpdateLead } from '@/hooks/use-leads';

interface Props {
  leads: LeadWithOwner[];
  isLoading: boolean;
  onSelect: (leadId: string) => void;
}

export function LeadPipeline({ leads, isLoading, onSelect }: Props) {
  const update = useUpdateLead();

  // Group leads by stage and sort each column by updatedAt desc so freshly
  // touched cards float to the top - leads don't have an explicit `position`,
  // and recency is the closest signal to "what to look at next".
  const grouped = useMemo(() => {
    const map: Record<LeadStage, LeadWithOwner[]> = {
      NEW: [],
      QUALIFIED: [],
      CONTACTED: [],
      DEMO_SCHEDULED: [],
      DEMO_COMPLETED: [],
      PROPOSAL: [],
      NEGOTIATION: [],
      WON: [],
      LOST: [],
    };
    for (const l of leads) map[l.stage].push(l);
    for (const key of Object.keys(map) as LeadStage[]) {
      map[key].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
    return map;
  }, [leads]);

  // Stable refs so DndContext doesn't see a new onDragEnd identity on every
  // optimistic cache write (which would re-attach the handler mid drop-animation).
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  const leadsRef = useRef(leads);
  leadsRef.current = leads;
  const updateRef = useRef(update);
  updateRef.current = update;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Guard against stray drag-end events that fire during dnd-kit's drop animation
  // - same shape as the tasks kanban no-loop fix.
  const inFlightRef = useRef(false);

  const onDragEnd = useCallback((e: DragEndEvent) => {
    if (!e.over) return;
    if (inFlightRef.current) return;

    const leadId = String(e.active.id);
    const overId = String(e.over.id);

    // overId is either a column key (`STAGE`) or a lead id we landed on.
    const current = groupedRef.current;
    const overStage = (STAGE_OPTIONS.includes(overId as LeadStage)
      ? (overId as LeadStage)
      : (Object.entries(current).find(([, list]) =>
          list.some((l) => l.id === overId),
        )?.[0] as LeadStage | undefined)) as LeadStage | undefined;
    if (!overStage) return;

    const existing = leadsRef.current.find((l) => l.id === leadId);
    if (!existing || existing.stage === overStage) return;

    inFlightRef.current = true;
    updateRef.current.mutate(
      { id: leadId, input: { stage: overStage } },
      {
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  }, []);

  const handleSelect = useCallback((id: string) => onSelectRef.current(id), []);

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto overscroll-x-contain pb-2 [-webkit-overflow-scrolling:touch]">
        {STAGE_OPTIONS.map((s) => (
          <div key={s} className="w-[80vw] max-w-[18rem] shrink-0 rounded-lg bg-bg-subtle p-2 md:w-72 md:max-w-none">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink">
              {stageLabel(s)}
            </div>
            <div className="mt-1 space-y-2 p-1">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto overscroll-x-contain pb-2 [-webkit-overflow-scrolling:touch]">
        {STAGE_OPTIONS.map((stage) => (
          <Column
            key={stage}
            stage={stage}
            leads={grouped[stage]}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </DndContext>
  );
}

function Column({
  stage,
  leads,
  onSelect,
}: {
  stage: LeadStage;
  leads: LeadWithOwner[];
  onSelect: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const itemIds = useMemo(() => leads.map((l) => l.id), [leads]);

  // Per-currency totals so multi-currency workspaces don't get a meaningless
  // mixed sum. Currencies with no estimated values are omitted.
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of leads) {
      if (!l.estimatedValue) continue;
      const n = Number(l.estimatedValue);
      if (!Number.isFinite(n)) continue;
      m.set(l.currency, (m.get(l.currency) ?? 0) + n);
    }
    return Array.from(m.entries());
  }, [leads]);

  return (
    <div className="w-[80vw] max-w-[18rem] shrink-0 rounded-lg bg-bg-subtle p-2 md:w-72 md:max-w-none">
      <div className="flex flex-col gap-0.5 px-2 py-1">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-ink uppercase tracking-wide">
            {stageLabel(stage)}
            <span className="ml-2 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
              {leads.length}
            </span>
          </div>
        </div>
        {totals.length > 0 ? (
          <div className="text-[11px] text-ink-muted break-words md:truncate" title={totals.map(([c, v]) => formatCurrency(v, c, { compact: true })).join(' · ')}>
            {totals.map(([c, v]) => formatCurrency(v, c, { compact: true })).join(' · ')}
          </div>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={`mt-1 min-h-[200px] space-y-2 rounded-md p-1 transition-colors ${
          isOver ? 'bg-brand-50' : ''
        }`}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {leads.map((l) => (
            <Card key={l.id} lead={l} onSelect={onSelect} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

function Card({
  lead,
  onSelect,
}: {
  lead: LeadWithOwner;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lead.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  } as React.CSSProperties;

  const tagsToShow = lead.tags.slice(0, 3);
  const remainingTags = lead.tags.length - tagsToShow.length;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`Open ${lead.name}`}
      onClick={(e) => {
        if (isDragging) return;
        e.stopPropagation();
        onSelect(lead.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(lead.id);
        }
      }}
      className="space-y-2 rounded-lg border border-line bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus
                 hover:border-line-strong transition-colors"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink leading-snug break-words">{lead.name}</div>
        {lead.company ? (
          <div className="text-xs text-ink-muted break-words">{lead.company}</div>
        ) : null}
      </div>
      {lead.estimatedValue ? (
        <div className="text-xs font-medium text-ink">
          {formatCurrency(lead.estimatedValue, lead.currency, { compact: true })}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <SourceBadge source={lead.source} />
        {/* The assignee, not the owner - a pipeline card is about who is
            working the lead now, and the "Unassigned" fallback below only
            reads correctly against the assignee. */}
        {lead.assignee ? (
          <Tooltip content={lead.assignee.name || lead.assignee.email || 'Assignee'}>
            <UserAvatar
              size="sm"
              name={lead.assignee.name || lead.assignee.email}
              image={lead.assignee.image}
            />
          </Tooltip>
        ) : (
          <span className="text-[10px] text-ink-disabled uppercase tracking-wide">Unassigned</span>
        )}
      </div>
      {tagsToShow.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tagsToShow.map((t) => (
            <span
              key={t}
              className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
            >
              {t}
            </span>
          ))}
          {remainingTags > 0 ? (
            <span className="text-[10px] text-ink-muted">+{remainingTags}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
