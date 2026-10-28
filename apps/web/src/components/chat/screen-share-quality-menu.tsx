'use client';

import { Check, ChevronDown, Settings2 } from 'lucide-react';
import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  SCREEN_SHARE_QUALITY_ORDER,
  SCREEN_SHARE_QUALITY_PROFILES,
  type ScreenShareQuality,
} from '@/lib/screen-share-quality';
import { cn } from '@/lib/utils';

interface Props {
  value: ScreenShareQuality;
  onChange: (quality: ScreenShareQuality) => void;
  /** Visual treatment: the dark call overlay vs the light voice panel. */
  variant?: 'overlay' | 'panel';
  /**
   * True while a share is live. Changing quality then restarts the track,
   * which re-opens the OS picker - we surface that as a hint in the menu.
   */
  sharing?: boolean;
}

/**
 * Picker for the screen-share quality profile (detail / motion / performance).
 * Usable before a share starts (sets the profile the next share will use) or
 * during one (restarts the share with the new profile).
 */
export function ScreenShareQualityMenu({
  value,
  onChange,
  variant = 'overlay',
  sharing = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const active = SCREEN_SHARE_QUALITY_PROFILES[value];
  const dark = variant === 'overlay';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Screen share quality: ${active.label}`}
        className={cn(
          'flex items-center gap-1.5 rounded-full px-3 transition-all',
          dark
            ? 'h-12 bg-white/10 text-sm text-white hover:bg-white/20'
            : 'bg-bg-subtle text-ink hover:bg-line h-9 text-sm',
        )}
      >
        <Settings2 className={dark ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
        <span className="hidden sm:inline">{active.spec}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="center" side="top" className="w-72">
        <div className="text-ink-muted px-2 py-1.5 text-xs font-semibold">Screen share quality</div>
        {SCREEN_SHARE_QUALITY_ORDER.map((id) => {
          const profile = SCREEN_SHARE_QUALITY_PROFILES[id];
          const selected = id === value;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
              className={cn(
                'hover:bg-bg-subtle flex w-full items-start gap-2 rounded-md px-2 py-2 text-left',
                selected && 'bg-bg-subtle',
              )}
            >
              <Check
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  selected ? 'text-brand-teal' : 'invisible',
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-ink text-sm font-medium">{profile.label}</span>
                  <span className="text-ink-muted text-xs">{profile.spec}</span>
                </span>
                <span className="text-ink-muted block text-xs">{profile.description}</span>
              </span>
            </button>
          );
        })}
        {sharing ? (
          <div className="border-line text-ink-muted mt-1 border-t px-2 pt-2 text-[11px]">
            Changing quality while sharing reopens the screen picker.
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
