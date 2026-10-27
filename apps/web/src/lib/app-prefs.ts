'use client';

import { useEffect, useState } from 'react';
import type {
  AppBodyMode as SharedAppBodyMode,
  AppNavLayout as SharedAppNavLayout,
  AppTheme as SharedAppTheme,
  AppUiScale as SharedAppUiScale,
} from '@botss/shared-types';

/**
 * App-wide appearance preferences. Light/dark theme + brand gradient choice.
 *
 * Mirrors the pattern in `chat-prefs.ts` (localStorage + custom-event broadcast
 * so all subscribed components re-render when the user changes settings on
 * /settings/appearance).
 *
 * ## Server is the source of truth; localStorage is the first-paint cache
 *
 * The values are stored per user on the server (`/users/me/preferences`) and
 * reconciled by `useUserPreferencesSync`. The copy here exists so
 * `ThemePreScript` can paint the right theme before React or the network are
 * up. `setAppAppearance` is the user-initiated write (it also announces
 * {@link APPEARANCE_USER_CHANGE_EVT} so the sync hook PATCHes the server);
 * `replaceAppAppearance` is the sync hook writing the server value back and
 * never echoes. The cache records which user it belongs to
 * ({@link claimAppearanceFor}) so one person's setup never paints for the next
 * person on a shared device.
 */

export type AppTheme = SharedAppTheme;

export interface GradientPreset {
  id: string;
  label: string;
  /** CSS gradient - written into `--brand-gradient` at runtime. */
  gradient: string;
  /** Faded variant for hover halos / soft surfaces. */
  soft: string;
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  {
    id: 'sunset',
    label: 'Sunset (default)',
    gradient: 'linear-gradient(90deg, #7B6FE8 0%, #E040FB 50%, #F4845F 100%)',
    soft: 'linear-gradient(90deg, rgba(123,111,232,0.10), rgba(224,64,251,0.10), rgba(244,132,95,0.10))',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    gradient: 'linear-gradient(90deg, #5B7CE8 0%, #22C5C5 50%, #36D399 100%)',
    soft: 'linear-gradient(90deg, rgba(91,124,232,0.10), rgba(34,197,197,0.10), rgba(54,211,153,0.10))',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    gradient: 'linear-gradient(90deg, #22C5C5 0%, #7B6FE8 50%, #E040FB 100%)',
    soft: 'linear-gradient(90deg, rgba(34,197,197,0.10), rgba(123,111,232,0.10), rgba(224,64,251,0.10))',
  },
  {
    id: 'ember',
    label: 'Ember',
    gradient: 'linear-gradient(90deg, #F4845F 0%, #E5484D 50%, #B5179E 100%)',
    soft: 'linear-gradient(90deg, rgba(244,132,95,0.10), rgba(229,72,77,0.10), rgba(181,23,158,0.10))',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    gradient: 'linear-gradient(90deg, #6655D4 0%, #9A6FE8 50%, #B68BE5 100%)',
    soft: 'linear-gradient(90deg, rgba(102,85,212,0.10), rgba(154,111,232,0.10), rgba(182,139,229,0.10))',
  },
  {
    id: 'graphite',
    label: 'Graphite (mono)',
    gradient: 'linear-gradient(90deg, #1A1A2E 0%, #4A4A66 50%, #888899 100%)',
    soft: 'linear-gradient(90deg, rgba(26,26,46,0.10), rgba(74,74,102,0.10), rgba(136,136,153,0.10))',
  },
];

export type AppBodyMode = SharedAppBodyMode;

/**
 * Which navigation chrome wraps the app.
 *
 * `topbar` is the original and stays the default - the centered gradient pill
 * over a blush bar. `rail` is the opt-in "Direction A" shell: a narrow dark
 * icon rail, a contextual sidebar that a feature can fill with its own
 * navigation, and a cool-neutral page palette that matches the chrome (see
 * the `[data-nav-layout='rail']` token block in globals.css).
 *
 * Both render the exact same pages with the same capabilities - the layout
 * changes how things look, never what a page can do or who can see it.
 */
export type AppNavLayout = SharedAppNavLayout;

export interface NavLayoutPreset {
  id: AppNavLayout;
  label: string;
  description: string;
}

export const NAV_LAYOUTS: NavLayoutPreset[] = [
  {
    id: 'topbar',
    label: 'Top bar (default)',
    description:
      'Centered pill nav across the top. Widest content area, nothing pinned to the side.',
  },
  {
    id: 'rail',
    label: 'Side rail',
    description:
      'Dark icon rail with a contextual sidebar that becomes your channels, folders and projects. Retunes page surfaces to match.',
  },
];

/** App-wide zoom, like a browser/desktop-app scale. Applied by scaling the
 *  root font size, which proportionally resizes every rem-based Tailwind size
 *  (text, spacing, icons) across the whole CRM. */
export type AppUiScale = SharedAppUiScale;

export interface UiScalePreset {
  id: AppUiScale;
  label: string;
  description: string;
  /** Root `<html>` font-size in px. 16 is the browser default (= 100%). */
  rootPx: number;
}

export const UI_SCALES: UiScalePreset[] = [
  { id: 'sm', label: 'Compact', description: 'Smaller - fit more on screen.', rootPx: 14 },
  { id: 'md', label: 'Default', description: 'Standard size (100%).', rootPx: 16 },
  { id: 'lg', label: 'Large', description: 'Bigger text and controls.', rootPx: 18 },
  { id: 'xl', label: 'Larger', description: 'Maximum size for readability.', rootPx: 20 },
];

export interface AppAppearance {
  theme: AppTheme;
  gradientId: string;
  /**
   * Body background mode. 'solid' uses the theme-aware `--bg-app` colour
   * (default - matches the original blush/dark surface). 'gradient' washes
   * the whole CRM with the active brand gradient at low opacity so panels
   * still read on top.
   */
  bodyMode: AppBodyMode;
  /** App-wide zoom level. See {@link UI_SCALES}. */
  uiScale: AppUiScale;
  /** Navigation chrome. See {@link NAV_LAYOUTS}. Defaults to the original top bar. */
  navLayout: AppNavLayout;
  /**
   * Rail layout only: whether the 250px contextual panel is collapsed away,
   * leaving just the 68px icon rail. The rail itself is never collapsible -
   * it is the only section switcher, and hiding it would strand navigation.
   */
  navPanelCollapsed: boolean;
}

export const DEFAULT_APPEARANCE: AppAppearance = {
  theme: 'light',
  gradientId: 'sunset',
  bodyMode: 'solid',
  uiScale: 'md',
  // The rail is opt-in. Everyone who has not chosen it keeps the top bar,
  // including users with prefs saved before `navLayout` existed - `safeParse`
  // merges over these defaults, so a missing key reads as 'topbar'.
  navLayout: 'topbar',
  navPanelCollapsed: false,
};

// Read verbatim by ThemePreScript - keep the two in step.
const KEY = 'botss.app.appearance.v1';
/** User id the cached appearance belongs to. Absent on caches written before
 *  server sync shipped; the first user to sign in then claims it. */
const OWNER_KEY = 'botss.app.appearance.owner';
const EVT = 'botss-app-appearance';
/** Fired only for user-initiated changes, with the changed keys as detail. */
export const APPEARANCE_USER_CHANGE_EVT = 'botss-app-appearance-user-change';

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export function getAppAppearance(): AppAppearance {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  return safeParse(window.localStorage.getItem(KEY), DEFAULT_APPEARANCE);
}

function writeAppearance(value: AppAppearance): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the in-memory broadcast below still applies it.
  }
  window.dispatchEvent(new CustomEvent(EVT, { detail: value }));
}

/** User-initiated change: applies instantly and queues a server save. */
export function setAppAppearance(next: Partial<AppAppearance>): void {
  if (typeof window === 'undefined') return;
  writeAppearance({ ...getAppAppearance(), ...next });
  window.dispatchEvent(new CustomEvent(APPEARANCE_USER_CHANGE_EVT, { detail: next }));
}

/** Server-originated value. Replaces the whole cache; never echoes a save. */
export function replaceAppAppearance(value: AppAppearance): void {
  if (typeof window === 'undefined') return;
  const current = getAppAppearance();
  if (JSON.stringify(current) === JSON.stringify(value)) return;
  writeAppearance(value);
}

export function getAppearanceOwner(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

/**
 * Bind the device cache to `userId`. A cache owned by someone else is reset to
 * defaults first, so the previous person's theme never paints for this one
 * while their own preferences load. An unowned (pre-sync) cache is adopted
 * as-is so existing users keep their setup.
 */
export function claimAppearanceFor(userId: string): void {
  if (typeof window === 'undefined' || !userId) return;
  const owner = getAppearanceOwner();
  if (owner === userId) return;
  if (owner !== null) replaceAppAppearance(DEFAULT_APPEARANCE);
  try {
    window.localStorage.setItem(OWNER_KEY, userId);
  } catch {
    // Non-fatal: the next claim simply runs again.
  }
}

/** Sign-out: forget this device's appearance so the next person starts clean. */
export function clearAppAppearance(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // Ignore; the owner check in claimAppearanceFor still protects the next user.
  }
  window.dispatchEvent(new CustomEvent(EVT, { detail: DEFAULT_APPEARANCE }));
}

export function useAppAppearance(): AppAppearance {
  const [value, setValue] = useState<AppAppearance>(DEFAULT_APPEARANCE);
  useEffect(() => {
    setValue(getAppAppearance());
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<AppAppearance>).detail;
      if (next) setValue(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setValue(getAppAppearance());
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return value;
}

/**
 * Resolve "system" theme to a concrete light/dark choice using prefers-color-scheme.
 * Returns 'light' on the server (where matchMedia is unavailable) so SSR HTML
 * stays consistent - the client-side ThemeMount applies the real value on
 * mount.
 */
export function resolveTheme(theme: AppTheme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function findGradient(id: string): GradientPreset {
  return GRADIENT_PRESETS.find((g) => g.id === id) ?? GRADIENT_PRESETS[0]!;
}

export function findUiScale(id: string): UiScalePreset {
  return UI_SCALES.find((s) => s.id === id) ?? UI_SCALES[1]!;
}
