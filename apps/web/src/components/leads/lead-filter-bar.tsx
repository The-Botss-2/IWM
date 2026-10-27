'use client';

import { Search, X } from 'lucide-react';
import type { LeadSource, LeadStage } from '@botss/shared-types';

import {
  SOURCE_OPTIONS,
  STAGE_OPTIONS,
  sourceLabel,
  stageLabel,
} from '@/components/leads/lead-badges';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';

export type StageFilter = 'ALL' | LeadStage;
export type SourceFilter = 'ALL' | LeadSource;

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  stage: StageFilter;
  onStageChange: (v: StageFilter) => void;
  source: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  assigneeId: string | null;
  onAssigneeChange: (v: string | null) => void;
}

function hasAny(p: Pick<Props, 'search' | 'stage' | 'source' | 'assigneeId'>): boolean {
  return p.search.length > 0 || p.stage !== 'ALL' || p.source !== 'ALL' || p.assigneeId !== null;
}

export function LeadFilterBar({
  search,
  onSearchChange,
  stage,
  onStageChange,
  source,
  onSourceChange,
  assigneeId,
  onAssigneeChange,
}: Props) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
      <div className="relative flex-1 sm:max-w-xs">
        <Search
          className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-disabled"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Search by name or company…"
          aria-label="Search leads"
          className="pl-8"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-row sm:flex-wrap">
        <Select value={stage} onValueChange={(v) => onStageChange(v as StageFilter)}>
          <SelectTrigger aria-label="Filter by stage" className="w-full sm:w-[160px]">
            <SelectValue placeholder="Stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All stages</SelectItem>
            {STAGE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {stageLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={(v) => onSourceChange(v as SourceFilter)}>
          <SelectTrigger aria-label="Filter by source" className="w-full sm:w-[160px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All sources</SelectItem>
            {SOURCE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {sourceLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="col-span-2 sm:w-[200px]">
          <WorkspaceMembersCombobox
            value={assigneeId}
            onChange={onAssigneeChange}
            placeholder="All assignees"
          />
        </div>
        {hasAny({ search, stage, source, assigneeId }) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="col-span-2 sm:col-auto"
            onClick={() => {
              onSearchChange('');
              onStageChange('ALL');
              onSourceChange('ALL');
              onAssigneeChange(null);
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
