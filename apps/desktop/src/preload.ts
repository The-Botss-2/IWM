import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal, sandboxed bridge exposed to the hosted web app as
 * `window.botssDesktop`. Context isolation is on and nodeIntegration is off, so
 * the renderer (the Next.js app served from BOTSS_APP_URL) can only reach the
 * handful of native capabilities whitelisted here - nothing else from Node or
 * Electron leaks across.
 *
 * The web side (`apps/web/src/lib/desktop-runtime.ts`) feature-detects this
 * object to tell the desktop client apart from a browser, and routes OS
 * notifications through `notify` so the main process raises the banner and
 * handles its click (focus the window, open the notification's URL).
 */
/**
 * OS power transitions the renderer (Chromium) can't observe on its own. The
 * web app uses these to go frugal on battery and to stop timers/animations
 * before the machine suspends. See apps/web/src/hooks/use-app-activity.ts.
 */
export type PowerState = 'battery' | 'ac' | 'suspend' | 'resume';

const api = {
  isDesktop: true as const,
  runtime: 'electron' as const,
  platform: process.platform,
  getAutoStart: (): Promise<boolean> => ipcRenderer.invoke('botss:getAutoStart'),
  setAutoStart: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('botss:setAutoStart', enabled),
  getPowerState: (): Promise<PowerState> => ipcRenderer.invoke('botss:getPowerState'),
  onPowerStateChange: (cb: (state: PowerState) => void): (() => void) => {
    const listener = (_e: unknown, state: PowerState): void => cb(state);
    ipcRenderer.on('botss:powerState', listener);
    return () => ipcRenderer.removeListener('botss:powerState', listener);
  },
  /** Raise an OS banner. `tag` replaces an earlier banner with the same tag;
   *  `type: 'call'` keeps it on screen until answered or dismissed. */
  notify: (args: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
    type?: 'message' | 'call' | 'generic';
  }): Promise<void> => ipcRenderer.invoke('botss:notify', args),
};

export type BotssDesktopApi = typeof api;

contextBridge.exposeInMainWorld('botssDesktop', api);
