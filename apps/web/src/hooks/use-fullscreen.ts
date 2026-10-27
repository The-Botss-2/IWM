'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * Element exposing the legacy WebKit fullscreen entrypoint. Older Safari and
 * WKWebView builds only ship the prefixed API, so we feature-
 * detect both rather than assume the unprefixed standard.
 */
interface FullscreenCapableElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface FullscreenCapableDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

/**
 * Drive the HTML5 Fullscreen API for a single element.
 *
 * `isFullscreen` stays in sync with the browser, so exiting via the Escape
 * key or the OS chrome flips it back to false without any polling. `toggle`
 * enters fullscreen on the referenced element and exits when already in it.
 * Both the standard and the WebKit-prefixed APIs are handled.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const doc = document as FullscreenCapableDocument;
    const sync = () => {
      const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setIsFullscreen(current != null && current === ref.current);
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [ref]);

  const toggle = useCallback(async () => {
    const el = ref.current as FullscreenCapableElement | null;
    if (!el) return;
    const doc = document as FullscreenCapableDocument;
    const active = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    try {
      if (active) {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } else {
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      }
    } catch {
      // requestFullscreen rejects when not user-initiated or unsupported -
      // nothing actionable, leave the UI as-is.
    }
  }, [ref]);

  return { isFullscreen, toggle };
}
