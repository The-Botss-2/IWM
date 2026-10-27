'use client';

import { CalendarDays, PenLine, X } from 'lucide-react';
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { moveBy, resizeBy, type FieldBox as Box } from '@/lib/signatures/fields';
import { cn } from '@/lib/utils';

/**
 * One field drawn over a PDF page. Position and size are page fractions, so
 * the box is laid out with percentages and needs no knowledge of zoom.
 *
 * `editable` enables drag-to-move, a corner handle to resize, and a remove
 * button (request dialog). Otherwise the box is a button (signing page).
 */
export function FieldBox({
  box,
  kind,
  color,
  label,
  editable = false,
  onChange,
  onRemove,
  onActivate,
  filled,
  highlighted = false,
}: {
  box: Box;
  kind: 'SIGNATURE' | 'DATE';
  color: string;
  label: string;
  editable?: boolean;
  onChange?: (next: Box) => void;
  onRemove?: () => void;
  onActivate?: () => void;
  /** What to show inside once the field is filled (signature image, date). */
  filled?: ReactNode;
  highlighted?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: Box } | null>(null);

  const pageRect = () => ref.current?.parentElement?.getBoundingClientRect();

  const begin = (mode: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: box };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const rect = pageRect();
    if (!d || !rect || !onChange) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    onChange(d.mode === 'move' ? moveBy(d.start, dx, dy) : resizeBy(d.start, dx, dy));
  };
  const end = () => {
    drag.current = null;
  };

  const Icon = kind === 'DATE' ? CalendarDays : PenLine;
  const style = {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    borderColor: color,
    backgroundColor: filled ? 'transparent' : `${color}1f`,
  };

  if (!editable) {
    return (
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          'pointer-events-auto absolute flex items-center justify-center overflow-hidden rounded-[3px] border-2 border-dashed text-[11px] font-semibold transition-shadow',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
          highlighted && 'animate-pulse ring-2 ring-offset-1',
          filled && 'border-solid',
        )}
        style={{ ...style, color }}
        aria-label={label}
      >
        {filled ?? (
          <span className="flex items-center gap-1 truncate px-1">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className="group pointer-events-auto absolute touch-none select-none rounded-[3px] border-2"
      style={style}
    >
      <div
        className="flex h-full w-full cursor-move items-center gap-1 overflow-hidden px-1 text-[11px] font-semibold"
        style={{ color }}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {filled ?? (
          <>
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </>
        )}
      </div>
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${label}`}
          className="absolute -right-2.5 -top-2.5 grid h-5 w-5 place-items-center rounded-full bg-white text-ink shadow ring-1 ring-line hover:bg-tint-error hover:text-state-error"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
      <div
        aria-hidden
        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm border-2 bg-white"
        style={{ borderColor: color }}
        onPointerDown={begin('resize')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  );
}
