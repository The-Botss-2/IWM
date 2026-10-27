'use client';

import type { CSSProperties } from 'react';
import { Toaster } from 'sonner';

import { useHtmlTheme } from '@/hooks/use-html-theme';

/**
 * Neutral toast surface mapped to the app's design tokens (styles/globals.css).
 * The tokens already flip under `html.dark`, so one map serves both themes;
 * `theme` below only switches sonner's rich (success/error) palettes.
 */
const TOKEN_VARS = {
  '--normal-bg': 'rgb(var(--bg-surface))',
  '--normal-text': 'rgb(var(--ink))',
  '--normal-border': 'rgb(var(--line))',
  '--border-radius': '0.5rem',
} as CSSProperties;

/**
 * The app's single toast viewport, mounted once in <Providers>. Trigger toasts
 * through `@/lib/toast` (toastError / toastSuccess / toastInfo), never by
 * importing sonner directly.
 *
 * Bottom-right on desktop. Under 600px sonner switches to a full-width bottom
 * stack; both offsets add the safe-area insets (the root viewport uses
 * `viewportFit: cover`) so toasts clear the home indicator / gesture bar.
 */
export function AppToaster() {
  const theme = useHtmlTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      richColors
      closeButton
      visibleToasts={4}
      toastOptions={{ duration: 4000 }}
      style={TOKEN_VARS}
      offset={{
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        right: 'calc(16px + env(safe-area-inset-right, 0px))',
      }}
      mobileOffset={{
        bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        left: 'calc(12px + env(safe-area-inset-left, 0px))',
        right: 'calc(12px + env(safe-area-inset-right, 0px))',
      }}
    />
  );
}
