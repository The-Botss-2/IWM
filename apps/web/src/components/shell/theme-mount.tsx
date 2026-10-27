'use client';

import { useEffect } from 'react';

import {
  findGradient,
  findUiScale,
  resolveTheme,
  useAppAppearance,
} from '@/lib/app-prefs';
import { toastErrorMessage } from '@/lib/toast';

/** Set on <html> by ThemePreScript when the saved appearance was unreadable. */
const THEME_ERROR_ATTR = 'data-theme-error';

/**
 * Reads the per-user appearance prefs from localStorage and mirrors them onto
 * the `<html>` element:
 *   - `class="dark"` toggle for Tailwind dark variants.
 *   - `--brand-gradient` and `--brand-gradient-soft` CSS variables so every
 *     `bg-brand-gradient` surface reflects the chosen preset without a reload.
 *   - `data-app-bg="gradient"` + `--app-bg-gradient` to wash the whole CRM in
 *     the brand gradient when the user opts into a gradient body.
 *
 * Mounted once at the root layout so the resolved theme applies on every
 * route - auth, app shell, public reader - and persists across reloads.
 * Renders nothing.
 */
export function ThemeMount() {
  const appearance = useAppAppearance();

  // The pre-hydration script found a corrupt saved appearance (and already
  // dropped it): tell the user once the app is up. Deferred a tick so the
  // toaster, mounted in the same commit, is subscribed.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute(THEME_ERROR_ATTR)) return;
    root.removeAttribute(THEME_ERROR_ATTR);
    const timer = window.setTimeout(() => toastErrorMessage("Couldn't apply your saved theme", { description: "The saved theme was invalid, so the default theme is showing. Pick a theme in Settings." }), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveTheme(appearance.theme);
    root.classList.toggle('dark', resolved === 'dark');

    const preset = findGradient(appearance.gradientId);
    root.style.setProperty('--brand-gradient', preset.gradient);
    root.style.setProperty('--brand-gradient-soft', preset.soft);

    // App-wide zoom: scale the root font size so every rem-based size (text,
    // spacing, icons) resizes proportionally across the CRM.
    root.style.fontSize = `${findUiScale(appearance.uiScale).rootPx}px`;

    // Mirrored onto <html> so CSS (and the pre-hydration script below) can
    // reserve the rail's column before React decides anything. AppChrome
    // reads the pref itself for the actual switch; this attribute exists so
    // the first paint already has the right shape.
    root.setAttribute('data-nav-layout', appearance.navLayout ?? 'topbar');

    if (appearance.bodyMode === 'gradient') {
      // Wash the whole CRM with a low-opacity slice of the active brand
      // gradient. Two layers stacked so the colour reads on both light and
      // dark surfaces.
      const wash = `linear-gradient(180deg, rgba(var(--bg-app) / 0.55), rgba(var(--bg-app) / 0.85)), ${preset.gradient}`;
      root.style.setProperty('--app-bg-gradient', wash);
      root.setAttribute('data-app-bg', 'gradient');
    } else {
      root.style.removeProperty('--app-bg-gradient');
      root.removeAttribute('data-app-bg');
    }

    // Track OS-level light/dark switch when the user picked "system".
    if (appearance.theme !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => {
      root.classList.toggle('dark', media.matches);
    };
    media.addEventListener('change', onMediaChange);
    return () => media.removeEventListener('change', onMediaChange);
  }, [
    appearance.theme,
    appearance.gradientId,
    appearance.bodyMode,
    appearance.uiScale,
    appearance.navLayout,
  ]);

  return null;
}

/**
 * Inline `<script>` rendered into <head> on the server so the saved theme
 * is applied **before** React hydrates. Without this, a user with the dark
 * theme briefly sees a light flash on every reload because the React
 * useEffect can only run after first paint.
 *
 * Safe to ship as a literal string - it only reads localStorage and the
 * media query, no user input gets interpolated in.
 */
export function ThemePreScript({ nonce }: { nonce?: string }) {
  const code = `
    try {
      var raw = localStorage.getItem('botss.app.appearance.v1');
      var prefs = raw ? JSON.parse(raw) : null;
      var theme = (prefs && prefs.theme) || 'light';
      var resolved = theme === 'system'
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      if (resolved === 'dark') document.documentElement.classList.add('dark');
      if (prefs && prefs.bodyMode === 'gradient') {
        document.documentElement.setAttribute('data-app-bg', 'gradient');
      }
      var scalePx = { sm: 14, md: 16, lg: 18, xl: 20 }[(prefs && prefs.uiScale) || 'md'] || 16;
      document.documentElement.style.fontSize = scalePx + 'px';
      // Navigation chrome. Set before hydration so a rail user does not get a
      // frame of the top bar - the appearance hook only reads localStorage in
      // an effect, which runs after first paint.
      var nav = (prefs && prefs.navLayout) === 'rail' ? 'rail' : 'topbar';
      document.documentElement.setAttribute('data-nav-layout', nav);
    } catch (e) {
      // Unreadable saved appearance (corrupt JSON): drop it so the next load
      // starts clean, and flag it so ThemeMount can tell the user. When
      // storage itself is unavailable there is nothing saved - stay quiet.
      if (raw) {
        try { localStorage.removeItem('botss.app.appearance.v1'); } catch (_) {}
        document.documentElement.setAttribute('${THEME_ERROR_ATTR}', '');
      }
    }
  `;
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: code }} />;
}
