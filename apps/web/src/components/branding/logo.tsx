import { cn } from '@/lib/utils';

type Variant = 'full' | 'icon';
type SizePreset = 'sm' | 'md' | 'lg';

interface LogoProps {
  variant?: Variant;
  size?: SizePreset | number;
  className?: string;
  /** When true the wordmark image is rendered inverted (white-on-dark surfaces). */
  inverse?: boolean;
}

const SIZE_PX: Record<SizePreset, number> = { sm: 24, md: 32, lg: 44 };

/**
 * Brand mark for The Botss. The "full" variant renders the official artwork
 * from `public/branding/logo.png` (wordmark with the hexagon icon embedded as
 * the "O"). The "icon" variant renders an inline SVG of the hexagon alone,
 * used in collapsed sidebars and tight spaces where the wordmark would not fit.
 *
 * The full variant uses a plain `<img>` rather than `next/image` because the
 * file is tiny, the size is height-driven, and skipping the optimisation
 * pipeline avoids runtime layout shift on slow networks.
 */
export function Logo({ variant = 'full', size = 'md', className, inverse }: LogoProps) {
  const height = typeof size === 'number' ? size : SIZE_PX[size];

  if (variant === 'icon') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/branding/logo-icon.svg"
        alt="The Botss"
        style={{ height, width: 'auto' }}
        className={cn(
          'shrink-0 select-none',
          inverse ? 'brightness-0 invert' : '',
          className,
        )}
        draggable={false}
      />
    );
  }

  // Always render the official `/branding/logo.svg` wordmark, on every
  // breakpoint. The earlier behaviour swapped in an inline hexagon below
  // 640px which didn't match the user's chosen brand mark - surface it
  // everywhere instead. Width is `auto` so the SVG scales to the requested
  // height without distorting; component callers cap the height to prevent
  // wordmark overlap on narrow surfaces.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/branding/logo.svg"
      alt="The Botss"
      style={{ height, width: 'auto' }}
      className={cn(
        'inline-block select-none align-middle',
        // Inverse surfaces (dark sidebars) need the wordmark inverted. The
        // artwork is dark on transparent; flipping brightness turns the
        // black text white while keeping the icon gradient intact for the
        // most part.
        inverse ? 'brightness-0 invert' : '',
        className,
      )}
      draggable={false}
    />
  );
}

