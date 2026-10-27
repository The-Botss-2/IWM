'use client';

import { CalendarRange, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/dist/style.css';

import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

import {
  DATE_RANGE_PRESETS,
  formatDayRange,
  matchingPreset,
  parseYmd,
  presetDayRange,
  toYmd,
  type DayRange,
} from '@/lib/date-range';
import { cn } from '@/lib/utils';

function toPickerRange(r: DayRange | null): DateRange | undefined {
  if (!r) return undefined;
  return { from: parseYmd(r.from) ?? undefined, to: parseYmd(r.to) ?? undefined };
}

/**
 * Start / end day picker with quick presets (This week, Last week, This month,
 * Last 30 days) and a one-month calendar for a custom range. Values are local
 * `yyyy-mm-dd` days; callers convert to instants at the API boundary.
 *
 * Presets apply at once; a custom pick applies on "Apply" so a half-picked
 * range never reaches the caller. `header` renders above the presets (the
 * dashboard puts its "filter on due / created / completed" switch there).
 */
export function DateRangePicker({
  value,
  onChange,
  header,
  label,
  placeholder = 'Date range',
  className,
  id,
}: {
  value: DayRange | null;
  onChange: (range: DayRange | null) => void;
  header?: ReactNode;
  /** Trigger text when a range is set; defaults to the formatted range. */
  label?: string;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(toPickerRange(value));
  const activePreset = matchingPreset(value);
  const custom = value !== null && activePreset === null;

  function handleOpenChange(next: boolean) {
    if (next) setDraft(toPickerRange(value));
    setOpen(next);
  }

  function apply(range: DayRange | null) {
    onChange(range);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 whitespace-nowrap text-xs',
            value && 'border-brand-purple/40 bg-brand-50/50 font-medium text-brand-700',
            className,
          )}
        >
          <CalendarRange className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
          <span className="max-w-[180px] truncate">
            {value ? label ?? formatDayRange(value) : placeholder}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-disabled" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-auto max-w-[calc(100vw-2rem)] p-2"
      >
        {header ? <div className="mb-2 border-b border-line/60 pb-2">{header}</div> : null}

        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Quick ranges">
          {DATE_RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => apply(presetDayRange(p.id))}
              aria-pressed={activePreset === p.id}
              className={cn(
                'whitespace-nowrap rounded px-2.5 py-1.5 text-left text-xs transition-colors',
                activePreset === p.id
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-ink hover:bg-bg-subtle',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-2 border-t border-line/60 pt-1">
          <p
            className={cn(
              'px-2.5 pt-1 text-[11px] font-semibold uppercase tracking-wider',
              custom ? 'text-brand-700' : 'text-ink-muted',
            )}
          >
            Custom
          </p>
          <DayPicker
            mode="range"
            selected={draft}
            onSelect={setDraft}
            numberOfMonths={1}
            weekStartsOn={1}
            className="p-1 text-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line/60 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 whitespace-nowrap text-xs"
            onClick={() => apply(null)}
            disabled={!value && !draft?.from}
          >
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 whitespace-nowrap text-xs"
            disabled={!draft?.from}
            onClick={() => {
              if (!draft?.from) return;
              const from = toYmd(draft.from);
              apply({ from, to: draft.to ? toYmd(draft.to) : from });
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
