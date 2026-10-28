'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Render the row but make it non-clickable. */
  disabled?: boolean;
  /** Visually mark as a destructive action (red text). */
  destructive?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Position in viewport coordinates. `null` hides the menu. */
  position: { x: number; y: number } | null;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Optional aria-label for the menu container. */
  ariaLabel?: string;
}

/**
 * Lightweight floating context menu rendered at an absolute viewport
 * position. Closes on outside click, Escape, scroll, or any item select.
 */
export function ContextMenu({ position, items, onClose, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, position]);

  if (!position) return null;

  const VIEWPORT_PADDING = 8;
  const APPROX_WIDTH = 220;
  const APPROX_HEIGHT = items.length * 36 + 12;
  const maxX =
    typeof window !== 'undefined'
      ? window.innerWidth - APPROX_WIDTH - VIEWPORT_PADDING
      : position.x;
  const maxY =
    typeof window !== 'undefined'
      ? window.innerHeight - APPROX_HEIGHT - VIEWPORT_PADDING
      : position.y;
  const x = Math.max(VIEWPORT_PADDING, Math.min(position.x, maxX));
  const y = Math.max(VIEWPORT_PADDING, Math.min(position.y, maxY));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel ?? 'Actions'}
      style={{ top: y, left: x }}
      className="border-line shadow-popover fixed z-50 min-w-[200px] rounded-lg border bg-white py-1.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
          className={cn(
            'flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm transition-colors',
            'focus-visible:bg-bg-subtle focus-visible:outline-none',
            item.disabled
              ? 'text-ink-disabled cursor-not-allowed'
              : item.destructive
                ? 'text-state-error hover:bg-tint-error'
                : 'text-ink hover:bg-bg-subtle',
          )}
        >
          {item.icon ? (
            <span className="text-ink-muted grid h-4 w-4 shrink-0 place-items-center">
              {item.icon}
            </span>
          ) : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}
