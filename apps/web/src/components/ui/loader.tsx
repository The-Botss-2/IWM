import { cn } from '@/lib/utils';

const SIZE = {
  xs: 'h-4 w-4',
  sm: 'h-5 w-5',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
} as const;

export type LoaderSize = keyof typeof SIZE;

export interface LoaderProps {
  size?: LoaderSize;
  /** Announced to screen readers only. Never rendered as visible text. */
  label?: string;
  className?: string;
}

/**
 * The app's loading indicator: the animated gradient ring. Use this instead of
 * visible "Loading ..." copy. List and card areas that have a known shape
 * should prefer `Skeleton`.
 */
export function Loader({ size = 'md', label = 'Loading', className }: LoaderProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center justify-center', className)}
    >
      <span aria-hidden className={cn('spinner-gradient', SIZE[size])} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface PageLoaderProps {
  label?: string;
  /** Fill the viewport (app boot) instead of a content area. */
  fullScreen?: boolean;
  className?: string;
}

/** A centered loader for a whole page, panel or route. */
export function PageLoader({ label = 'Loading', fullScreen = false, className }: PageLoaderProps) {
  return (
    <div
      className={cn(
        'flex w-full items-center justify-center',
        fullScreen ? 'min-h-screen' : 'min-h-[40vh]',
        className,
      )}
    >
      <Loader size="lg" label={label} />
    </div>
  );
}
