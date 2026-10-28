'use client';

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  leading?: ReactNode;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No results.',
  clearable = false,
  clearLabel = 'Clear',
  className,
  disabled,
  triggerClassName,
  id,
}: {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
  clearLabel?: string;
  className?: string;
  disabled?: boolean;
  triggerClassName?: string;
  /** Lets a <Label htmlFor> name the trigger. */
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-10 w-full justify-between font-normal',
            !selected && 'text-ink-disabled',
            triggerClassName,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected?.leading}
            <span className="truncate">{selected ? selected.label : placeholder}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('w-[var(--radix-popover-trigger-width)] p-0', className)}
        align="start"
      >
        <Command className="max-h-72 overflow-hidden rounded-md" loop>
          <div className="border-line border-b px-2">
            <CommandInput
              placeholder={searchPlaceholder}
              className="placeholder:text-ink-disabled flex h-10 w-full bg-transparent py-2 text-sm outline-none"
            />
          </div>
          <CommandList className="max-h-60 overflow-auto p-1">
            <CommandEmpty className="text-ink-muted px-2 py-3 text-center text-sm">
              {emptyText}
            </CommandEmpty>
            {clearable ? (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="aria-selected:bg-bg-subtle flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm"
                >
                  <span className="text-ink-muted">{clearLabel}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.description ?? ''} ${option.value}`}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="aria-selected:bg-bg-subtle flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm"
                >
                  {option.leading}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-ink">{option.label}</span>
                    {option.description ? (
                      <span className="text-ink-muted text-xs">{option.description}</span>
                    ) : null}
                  </span>
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      option.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
