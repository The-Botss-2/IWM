import path from 'node:path';

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  powerMonitor,
  session,
  shell,
  Notification,
} from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Botss desktop shell (Electron). Mirrors the previous Tauri 2 shell: it opens
 * the hosted web app in a native window and adds OS-level capabilities the
 * browser can't (tray, close-to-tray, `botss://` deep links, auto-update,
 * launch-on-startup). There is NO parallel UI here - the entire interface is
 * the same Next.js build served at BOTSS_APP_URL, exactly like the web client.
 */

// The hosted web app, from BOTSS_APP_URL. Defaults to the local dev server;
// set it to your deployment's URL (e.g. https://app.example.com) for real use.
const APP_URL = process.env.BOTSS_APP_URL?.trim() || 'http://localhost:3000';
// Extra origins that count as the app (e.g. an old domain still in links), from
// the comma-separated BOTSS_APP_EXTRA_ORIGINS. Navigations to them stay in the window.
const APP_ORIGINS = new Set([
  new URL(APP_URL).origin,
  ...(process.env.BOTSS_APP_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin),
]);
const PROTOCOL = 'botss';

/**
 * OS capabilities the hosted app is allowed to use without a prompt:
 * notifications, camera/mic and screen capture for calls, clipboard for copy
 * and paste, and fullscreen for video. Everything else (geolocation, MIDI,
 * USB/HID/serial, idle detection, ...) is denied.
 */
const ALLOWED_PERMISSIONS = new Set<string>([
  'notifications',
  'media',
  'display-capture',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection',
]);

function isAppOrigin(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return APP_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

/**
 * Recent banners by tag. Holding a reference keeps the Notification object
 * alive (a garbage-collected one loses its click handler, including for a
 * banner still sitting in the Windows Action Center), and a new banner with
 * the same tag replaces the old one instead of stacking. Entries leave when
 * clicked, replaced, or pushed out by the cap; not on 'close', which Windows
 * also reports when a banner moves into the Action Center.
 */
const openNotifications = new Map<string, { n: Notification; type: NotifyType }>();
const MAX_KEPT_NOTIFICATIONS = 100;
let untaggedNotificationSeq = 0;
/** A ringing call banner is closed after this; the call has timed out by then. */
const CALL_BANNER_MAX_MS = 60_000;

type NotifyType = 'message' | 'call' | 'generic';
interface NotifyArgs {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  type: NotifyType;
}

function cappedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/** The renderer is the hosted web app, so treat its IPC arguments as untrusted. */
function parseNotifyArgs(raw: unknown): NotifyArgs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = cappedString(r.title, 200);
  if (!title) return null;
  const type = r.type === 'call' || r.type === 'message' ? r.type : 'generic';
  return {
    title,
    body: cappedString(r.body, 500) ?? '',
    url: cappedString(r.url, 2048),
    tag: cappedString(r.tag, 200),
    type,
  };
}

/**
 * Resolve a notification URL to an absolute app URL. Relative paths resolve
 * against APP_URL; absolute URLs must be on one of our origins. Anything else
 * is refused, so a banner can never send the window to a foreign site.
 */
function resolveAppUrl(url: string): string | null {
  try {
    const resolved = new URL(url, APP_URL);
    return isAppOrigin(resolved.href) ? resolved.href : null;
  } catch {
    return null;
  }
}

/**
 * Open `url` in the window the way the mobile shell does: a cancelable
 * `botss:navigate` event the web app turns into a client-side route change
 * (no reload, so a running call survives), and a full load when nothing took
 * it (signed out, an older web build, a page still loading).
 */
function navigateInApp(url: string): void {
  const win = mainWindow;
  if (!win) return;
  const fallback = (): void => {
    if (!win.isDestroyed()) void win.loadURL(url);
  };
  const detail = JSON.stringify({ url });
  const script =
    `(function(){var e=new CustomEvent('botss:navigate',{detail:${detail},cancelable:true});` +
    `return !window.dispatchEvent(e);})()`;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    fallback();
  }, 3_000);
  win.webContents
    .executeJavaScript(script)
    .then((handled: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (handled !== true) fallback();
    })
    .catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fallback();
    });
}

function forgetNotification(key: string, n: Notification): void {
  if (openNotifications.get(key)?.n === n) openNotifications.delete(key);
}

function showNotification(args: NotifyArgs): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
  const isCall = args.type === 'call';
  const n = new Notification({
    title: args.title,
    body: args.body,
    icon: iconPath,
    // A ringing call stays on screen until answered or dismissed, like the
    // phone's call notification (Windows/Linux; macOS uses its own setting).
    ...(isCall ? { timeoutType: 'never' as const, urgency: 'critical' as const } : {}),
  });

  const key = args.tag ?? `untagged:${(untaggedNotificationSeq += 1)}`;
  const previous = openNotifications.get(key);
  if (previous) {
    previous.n.close();
    openNotifications.delete(key);
  }
  openNotifications.set(key, { n, type: args.type });
  if (openNotifications.size > MAX_KEPT_NOTIFICATIONS) {
    const oldest = openNotifications.keys().next().value;
    if (oldest !== undefined) openNotifications.delete(oldest);
  }

  const target = args.url ? resolveAppUrl(args.url) : null;
  n.on('click', () => {
    forgetNotification(key, n);
    // Bring the window back first; a window recreated from the tray loads
    // the target directly.
    if (!mainWindow) {
      createWindow(target ?? APP_URL);
      return;
    }
    showWindow();
    if (target) navigateInApp(target);
  });
  n.on('failed', () => forgetNotification(key, n));
  if (isCall) {
    setTimeout(() => {
      if (openNotifications.get(key)?.n !== n) return;
      n.close();
      forgetNotification(key, n);
    }, CALL_BANNER_MAX_MS);
  }
  n.show();
}

/** The window came forward: its incoming-call screen takes over from the call banners. */
function closeCallNotifications(): void {
  for (const [key, entry] of openNotifications) {
    if (entry.type !== 'call') continue;
    entry.n.close();
    openNotifications.delete(key);
  }
}

/**
 * Translate a `botss://chat/<id>` deep link into the hosted-app URL
 * `${APP_URL}/chat/<id>`. The scheme + double slash are stripped; everything
 * after becomes the route path.
 */
function deepLinkToAppUrl(deepLink: string): string {
  const rest = deepLink.slice(`${PROTOCOL}://`.length).replace(/^\/+/, '');
  return `${APP_URL.replace(/\/+$/, '')}/${rest}`;
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleDeepLink(rawUrl: string | undefined): void {
  if (!rawUrl || !rawUrl.startsWith(`${PROTOCOL}://`)) return;
  showWindow();
  mainWindow?.loadURL(deepLinkToAppUrl(rawUrl));
}

function createWindow(initialUrl: string = APP_URL): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    title: 'Botss',
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Let Chromium throttle timers/rAF while the window is hidden in the tray
      // (default, but explicit). The chat socket is event-driven, so server
      // pushes + calls keep arriving; only background busywork is throttled.
      backgroundThrottling: true,
    },
  });

  void mainWindow.loadURL(initialUrl);

  // target=_blank / window.open: keep app origin in-app, send the rest to the
  // OS browser so external links don't spawn chromeless Electron windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppOrigin(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Full-page navigations to a foreign origin (e.g. an OAuth provider link the
  // user clicked) open externally instead of replacing the app shell.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Close-to-tray: the window hides instead of quitting so notifications keep
  // firing. Real quit goes through the tray menu / before-quit.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('focus', closeCallNotifications);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // Packaged builds ship the icon in resources/; in dev fall back to the repo
  // build asset. An empty image still yields a clickable tray entry.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Botss', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit Botss',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('Botss');
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

// Single-instance: a second launch (or a deep link opened while running)
// focuses the existing window instead of starting a new process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows shows toast notifications only for an app with an explicit
  // AppUserModelID that matches its install shortcut; without it the OS
  // silently drops the banner (the web app's own sound still plays). Must match
  // electron-builder.yml appId.
  if (app.isPackaged) {
    app.setAppUserModelId('com.example.iwm');
  }

  app.on('second-instance', (_event, argv) => {
    // Windows / Linux deliver the deep link as a process argument.
    handleDeepLink(argv.find((a) => a.startsWith(`${PROTOCOL}://`)));
    showWindow();
  });

  // Register `botss://` as a default protocol client. In dev (unpackaged) the
  // exec path is electron itself, so the script path must be forwarded.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.whenReady().then(() => {
    // The shell only ever loads our own origin (foreign navigations are sent to
    // the OS browser in will-navigate), so grant the web app the OS capabilities
    // it asks for - notifications, plus camera/mic + screen capture for calls -
    // without a prompt. This is why desktop notifications fire without the user
    // having to click "Allow": the user already chose to install and run Botss.
    // (macOS still gates notifications once at the OS level - that's unavoidable
    // and expected.)
    //
    // Granted only for an allowlisted set of permissions and only when the
    // request comes from our own origin. It used to answer yes to everything
    // for any frame, including geolocation and device access.
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        const origin = details?.requestingUrl ?? webContents?.getURL();
        callback(ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(origin));
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (_webContents, permission, requestingOrigin) =>
        ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(requestingOrigin),
    );

    createWindow();
    createTray();

    // Launch-on-startup bridge for the in-app Settings toggle (preload exposes
    // window.botssDesktop.{get,set}AutoStart). The macOS-only `openAsHidden`
    // flag used to be passed here; it was a no-op on macOS 13+ and on
    // Windows/Linux, and Electron removed it, so it is no longer sent.
    ipcMain.handle('botss:getAutoStart', () =>
      app.getLoginItemSettings().openAtLogin,
    );
    ipcMain.handle('botss:setAutoStart', (_event, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
      return true;
    });

    // Forward OS power transitions to the renderer so the web app can go frugal
    // on battery and stop timers/animations before the machine suspends. The
    // DOM can't see these; see apps/web/src/hooks/use-app-activity.ts.
    const sendPower = (state: 'battery' | 'ac' | 'suspend' | 'resume'): void => {
      mainWindow?.webContents.send('botss:powerState', state);
    };
    ipcMain.handle('botss:getPowerState', () =>
      powerMonitor.onBatteryPower ? 'battery' : 'ac',
    );
    powerMonitor.on('on-battery', () => sendPower('battery'));
    powerMonitor.on('on-ac', () => sendPower('ac'));
    powerMonitor.on('suspend', () => sendPower('suspend'));
    powerMonitor.on('resume', () => sendPower('resume'));

    // OS banners requested by the web app (window.botssDesktop.notify). Only
    // our own pages may raise them, and the arguments are checked and capped.
    ipcMain.handle('botss:notify', (event, raw: unknown) => {
      if (!isAppOrigin(event.senderFrame?.url)) return;
      const args = parseNotifyArgs(raw);
      if (args) showNotification(args);
    });

    // macOS deep links arrive via open-url once the app is running.
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleDeepLink(url);
    });

    // Cold-start deep link on Windows / Linux (passed as an argv).
    handleDeepLink(process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)));

    // Silent update check against the electron-builder generic feed
    // (see electron-builder.yml publish.url). Only meaningful when packaged
    // and code-signed; no-ops harmlessly otherwise.
    if (app.isPackaged) {
      autoUpdater.autoDownload = true;
      void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
    }

    app.on('activate', () => {
      // macOS dock click with no windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

// Keep running in the tray when every window is closed (all platforms). The
// user fully exits via the tray's "Quit Botss".
app.on('window-all-closed', () => {
  // Intentionally do not quit - close-to-tray semantics.
});
