'use client';

import { format } from 'date-fns';
import { CalendarIcon, X } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';

import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

import { cn } from '@/lib/utils';

export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
  className,
  disabled,
  size = 'md',
  id,
}: {
  value: Date | null | undefined;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** `sm` is for dense table cells - drops the pill radius + 40px height so
   *  the trigger fits a 32px row. `md` keeps the default brand pill shape. */
  size?: 'sm' | 'md';
  /** Lets a <Label htmlFor> name the trigger. */
  id?: string;
}) {
  const compact = size === 'sm';
  return (
    <Popover>
      <div className={cn('relative flex items-center gap-1', className)}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            size={compact ? 'sm' : 'md'}
            disabled={disabled}
            className={cn(
              'flex-1 justify-start font-normal',
              compact ? 'h-8 min-h-0 rounded-md px-2.5' : 'h-10',
              !value && 'text-ink-disabled',
            )}
          >
            <CalendarIcon className={cn('opacity-60', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
            {value ? format(value, compact ? 'MMM d' : 'PP') : placeholder}
          </Button>
        </PopoverTrigger>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size={compact ? 'sm' : 'icon'}
            aria-label="Clear date"
            onClick={() => onChange(null)}
            disabled={disabled}
            className={cn(
              compact && 'h-8 w-8 min-h-0 min-w-0 rounded-md p-0',
            )}
          >
            <X className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
          </Button>
        ) : null}
      </div>
      <PopoverContent className="w-auto p-0">
        <DayPicker
          mode="single"
          selected={value ?? undefined}
          onSelect={(d) => onChange(d ?? null)}
          className="p-3"
        />
      </PopoverContent>
    </Popover>
  );
}
