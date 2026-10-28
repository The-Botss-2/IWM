'use client';

/**
 * The native bridge the Electron desktop shell injects via its preload
 * (`apps/desktop/src/preload.ts`) as `window.botssDesktop`. Its presence is
 * how the web app tells the desktop client apart from a plain browser; the
 * preload runs before any page script, so a simple existence check is
 * reliable well before React hydrates.
 */
interface BotssDesktopBridge {
  isDesktop: true;
  runtime: 'electron';
  platform: string;
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  notify?: (args: NativeNotification) => Promise<void>;
}

/** One OS banner. `type: 'call'` makes it sticky in a shell that supports it. */
export interface NativeNotification {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  type?: 'message' | 'call' | 'generic';
}

function electronBridge(): BotssDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { botssDesktop?: BotssDesktopBridge };
  return w.botssDesktop ?? null;
}

/** Running inside the Botss Electron desktop shell. */
export function isDesktop(): boolean {
  return electronBridge() !== null;
}

/**
 * Open a notification's URL inside the app: the same cancelable
 * `botss:navigate` event the shells dispatch (handled by
 * `useNativeNavigation` as a client-side route change, so a running call
 * survives), with a full navigation when nothing took it.
 */
function openNotificationUrl(url: string): void {
  let target: URL;
  try {
    target = new URL(url, window.location.origin);
  } catch {
    return;
  }
  if (target.origin !== window.location.origin) return;
  const event = new CustomEvent('botss:navigate', {
    detail: { url: target.href },
    cancelable: true,
  });
  if (window.dispatchEvent(event)) window.location.href = target.href;
}

/**
 * In-page banner for a desktop shell older than the `notify` bridge. Electron
 * supports the Web Notification API in the renderer (permission is granted by
 * the shell), so those builds still get a pop-up; a click brings the window
 * forward and opens the URL.
 */
function notifyInPage(args: NativeNotification): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(args.title, {
      body: args.body,
      ...(args.tag ? { tag: args.tag } : {}),
      requireInteraction: args.type === 'call',
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus blocked */
      }
      if (args.url) openNotificationUrl(args.url);
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Show an OS notification through the Electron main process, which raises a
 * proper Windows Action Center / macOS Notification Center banner that
 * outlives the window being hidden to the tray, and routes a click on it to
 * `args.url`. A shell without the `notify` bridge gets an in-page Web
 * Notification instead. Returns false in plain browsers so the caller can
 * fall back to the web path.
 *
 * Failures are intentionally swallowed: a notification miss should never
 * surface as a user-visible error.
 */
export async function notifyNative(args: NativeNotification): Promise<boolean> {
  const electron = electronBridge();
  if (!electron) return false;
  if (!electron.notify) return notifyInPage(args);
  try {
    await electron.notify(args);
    return true;
  } catch {
    return false;
  }
}
