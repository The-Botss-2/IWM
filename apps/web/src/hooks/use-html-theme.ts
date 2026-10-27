'use client';

import { useSyncExternalStore } from 'react';

export type HtmlTheme = 'light' | 'dark';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function getSnapshot(): HtmlTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function getServerSnapshot(): HtmlTheme {
  return 'light';
}

/**
 * The theme currently applied to `<html>` (ThemeMount toggles `class="dark"`).
 * Read-only mirror for portal-rendered UI such as the toast viewport, so it
 * follows the user's appearance prefs without depending on how they're stored.
 */
export function useHtmlTheme(): HtmlTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
