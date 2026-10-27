'use client';

import { mergeAttributes } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ImageOff,
  Loader2,
  Text as TextIcon,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { promptDialog } from '@/lib/prompt';
import { cn } from '@/lib/utils';

// Quick-pick widths surfaced as buttons in the toolbar. The image is no longer
// constrained to these - the drag handle produces any width in [MIN, MAX]% -
// but the drag lightly snaps to a preset when it lands close to one, and the
// buttons stay as one-click shortcuts to the common sizes.
const PRESET_WIDTHS = [25, 50, 75, 100] as const;
const MIN_WIDTH = 10;
const MAX_WIDTH = 100;
// Within this many percent of a preset, the drag snaps to it - makes 50%/100%
// easy to hit while still allowing any intermediate width.
const SNAP_THRESHOLD = 3;

const ALIGNS = ['left', 'center', 'right'] as const;
type Align = (typeof ALIGNS)[number];

function clampWidth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

// display:block + margin encode the alignment as inline styles so it survives
// everywhere the HTML travels - the public reader AND outgoing email, where the
// `.botss-doc-image[data-align]` CSS class rules don't exist.
function alignStyle(align: Align): string {
  if (align === 'left') return 'display: block; margin-left: 0; margin-right: auto';
  if (align === 'right') return 'display: block; margin-left: auto; margin-right: 0';
  return 'display: block; margin-left: auto; margin-right: auto';
}

export const CustomImage = Image.extend({
  name: 'image',
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: 100,
        parseHTML: (el): number => {
          const raw = el.getAttribute('data-width') ?? el.getAttribute('width');
          return clampWidth(raw ?? 100);
        },
        renderHTML: (attrs) => {
          const w = clampWidth(attrs.width);
          return {
            'data-width': String(w),
            // No trailing semicolon: Tiptap's mergeAttributes joins multiple
            // `style` contributions (width here + margin from `align`) with
            // '; ', so a trailing one would double up.
            style: `width: ${w}%; height: auto; max-width: 100%`,
          };
        },
      },
      align: {
        default: 'center' as Align,
        parseHTML: (el): Align => {
          const raw = el.getAttribute('data-align');
          return (ALIGNS as readonly string[]).includes(raw ?? '')
            ? (raw as Align)
            : 'center';
        },
        // Stored as data-align + an inline margin/display style on the rendered
        // img. The visual margin shift is also applied by the wrapper in the
        // node-view (for the editor) and mirrored by the
        // `.botss-doc-image[data-align=...]` CSS rules in globals.css.
        renderHTML: (attrs) => {
          const align: Align = (ALIGNS as readonly string[]).includes(attrs.align)
            ? (attrs.align as Align)
            : 'center';
          return { 'data-align': align, style: alignStyle(align) };
        },
      },
      uploading: {
        default: false,
        rendered: false,
      },
      uploadId: {
        default: null as string | null,
        rendered: false,
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: cn('botss-doc-image', HTMLAttributes.class),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

function ImageNodeView({
  node,
  selected,
  updateAttributes,
  deleteNode,
  editor,
}: NodeViewProps) {
  const {
    src,
    alt,
    width: rawWidth,
    align: rawAlign,
    uploading,
  } = node.attrs as {
    src: string | null;
    alt?: string | null;
    width: number;
    align: Align;
    uploading: boolean;
  };
  const width = clampWidth(rawWidth);
  const align: Align = (ALIGNS as readonly string[]).includes(rawAlign)
    ? rawAlign
    : 'center';

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverWidth, setHoverWidth] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>(
    'loading',
  );

  useEffect(() => {
    setLoadState('loading');
  }, [src]);

  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!editor.isEditable) return;
      e.preventDefault();
      const container = containerRef.current?.parentElement;
      if (!container) return;
      const containerWidth = container.getBoundingClientRect().width;
      const startX = e.clientX;
      const startWidth = (width / 100) * containerWidth;

      const onMove = (ev: PointerEvent): void => {
        const px = startWidth + (ev.clientX - startX);
        const pct = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (px / containerWidth) * 100));
        setHoverWidth(magneticSnap(pct));
      };
      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        setHoverWidth((current) => {
          if (current != null && current !== width) {
            updateAttributes({ width: current });
          }
          return null;
        });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [editor.isEditable, updateAttributes, width],
  );

  // Alt-text edit. window.prompt is a no-op in the Electron desktop shell, so
  // we route through the app-level prompt dialog (rendered via a portal at the
  // root, so it doesn't collide with the editor's focus or the BubbleMenu's
  // tippy positioning).
  const editAlt = useCallback(() => {
    void promptDialog({
      title: 'Alternative text',
      description: 'Describe this image for screen readers.',
      defaultValue: alt ?? '',
      confirmLabel: 'Save',
    }).then((next) => {
      if (next === null) return;
      updateAttributes({ alt: next });
    });
  }, [alt, updateAttributes]);

  const displayWidth = hoverWidth ?? width;
  const showSkeleton = uploading || !src || loadState === 'loading';
  const showError = !uploading && !!src && loadState === 'error';

  // Wrapper margin reflects alignment so 25/50/75% widths sit at the chosen
  // edge of the column. Full-width (100%) ignores alignment visually but the
  // attribute is still saved.
  const alignClass =
    align === 'left'
      ? 'ml-0 mr-auto'
      : align === 'right'
      ? 'ml-auto mr-0'
      : 'mx-auto';

  const showToolbar =
    selected && editor.isEditable && !uploading && loadState !== 'loading';

  return (
    <NodeViewWrapper
      className={cn('group relative my-3', alignClass)}
      style={{ width: `${displayWidth}%` }}
      data-drag-handle
      data-align={align}
    >
      <div ref={containerRef} className="relative">
        {/* Floating image-formatting toolbar. Shown when the image is
            selected and the user can edit. Sits above the image so it never
            collides with the right-edge resize handle. */}
        {showToolbar ? (
          <div
            role="toolbar"
            aria-label="Image formatting"
            className="absolute -top-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-line bg-white p-1 shadow-md"
            onMouseDown={(e) => e.preventDefault()}
          >
            <ToolButton
              label="Align left"
              icon={AlignLeft}
              active={align === 'left'}
              onClick={() => updateAttributes({ align: 'left' })}
            />
            <ToolButton
              label="Align center"
              icon={AlignCenter}
              active={align === 'center'}
              onClick={() => updateAttributes({ align: 'center' })}
            />
            <ToolButton
              label="Align right"
              icon={AlignRight}
              active={align === 'right'}
              onClick={() => updateAttributes({ align: 'right' })}
            />
            <Divider />
            {PRESET_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`Resize to ${w}%`}
                aria-pressed={width === w}
                onClick={() => updateAttributes({ width: w })}
                title={`${w}%`}
                className={cn(
                  'inline-flex h-7 min-w-[32px] items-center justify-center rounded px-1.5 text-[11px] font-medium text-ink-muted hover:bg-bg-subtle hover:text-ink',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
                  width === w ? 'bg-brand-50 text-brand-700' : '',
                )}
              >
                {w}%
              </button>
            ))}
            <Divider />
            <ToolButton
              label={alt ? `Edit alt text (current: ${alt})` : 'Add alt text'}
              icon={TextIcon}
              active={!!alt && alt.length > 0}
              onClick={editAlt}
            />
            <Divider />
            <ToolButton
              label="Delete image"
              icon={Trash2}
              tone="danger"
              onClick={() => deleteNode()}
            />
          </div>
        ) : null}

        {showSkeleton ? (
          <div
            className="flex aspect-[16/9] w-full min-h-[120px] items-center justify-center rounded-md border border-dashed border-line-strong bg-bg-subtle text-ink-disabled"
            role="status"
            aria-label={uploading ? 'Uploading image' : 'Loading image'}
          >
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        ) : null}

        {showError ? (
          <div
            className="flex aspect-[16/9] w-full min-h-[120px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-state-error/30 bg-tint-error text-xs text-state-error"
            role="alert"
          >
            <ImageOff className="h-5 w-5" aria-hidden />
            <span>Couldn&apos;t load image</span>
          </div>
        ) : null}

        {src && !uploading ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ''}
            onLoad={() => setLoadState('loaded')}
            onError={() => setLoadState('error')}
            className={cn(
              'block w-full rounded-md',
              loadState === 'loading' || loadState === 'error'
                ? 'absolute inset-0 opacity-0'
                : 'opacity-100',
              selected && loadState === 'loaded'
                ? 'outline outline-2 outline-brand-500'
                : '',
            )}
            style={{ height: 'auto' }}
            draggable={false}
          />
        ) : null}

        {selected && editor.isEditable && !uploading && loadState === 'loaded' ? (
          <>
            <div
              role="slider"
              aria-label="Resize image"
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={MAX_WIDTH}
              aria-valuenow={displayWidth}
              tabIndex={0}
              onPointerDown={startResize}
              className="absolute right-0 top-1/2 h-6 w-2 -translate-y-1/2 cursor-ew-resize rounded-full bg-brand-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            />
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-ink/70 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              {displayWidth}%
            </div>
          </>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}

interface ToolButtonProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  tone?: 'default' | 'danger';
  onClick: () => void;
}

function ToolButton({
  label,
  icon: Icon,
  active = false,
  tone = 'default',
  onClick,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        tone === 'danger'
          ? 'text-ink-muted hover:bg-tint-error hover:text-state-error'
          : 'text-ink-muted hover:bg-bg-subtle hover:text-ink',
        active && tone !== 'danger' ? 'bg-brand-50 text-brand-700' : '',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />;
}

// Free-form width, with a light magnetic pull toward a preset when the drag
// lands within SNAP_THRESHOLD of one - so exact 50%/100% stay easy to hit.
function magneticSnap(pct: number): number {
  for (const w of PRESET_WIDTHS) {
    if (Math.abs(pct - w) <= SNAP_THRESHOLD) return w;
  }
  return Math.round(pct);
}
