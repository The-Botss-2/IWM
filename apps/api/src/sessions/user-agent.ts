/**
 * Tiny user-agent summariser for the Devices page. Pure and dependency free:
 * it only needs to give a person a recognisable label for each signed-in
 * device, not to be a full UA database.
 */
export interface ParsedUserAgent {
  /** Short device label, e.g. "iPhone", "Windows PC". */
  device: string;
  browser: string;
  os: string;
}

const UNKNOWN = 'Unknown';

function detectOs(ua: string): { os: string; device: string } {
  if (/iPhone/i.test(ua)) return { os: 'iOS', device: 'iPhone' };
  if (/iPad/i.test(ua)) return { os: 'iPadOS', device: 'iPad' };
  if (/Android/i.test(ua)) {
    return { os: 'Android', device: /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet' };
  }
  if (/Windows/i.test(ua)) return { os: 'Windows', device: 'Windows PC' };
  if (/CrOS/i.test(ua)) return { os: 'ChromeOS', device: 'Chromebook' };
  if (/Mac OS X|Macintosh/i.test(ua)) return { os: 'macOS', device: 'Mac' };
  if (/Linux|X11/i.test(ua)) return { os: 'Linux', device: 'Linux PC' };
  return { os: UNKNOWN, device: 'Unknown device' };
}

function detectBrowser(ua: string): string {
  // Order matters: Edge, Opera and Electron-based apps also say "Chrome".
  if (/Electron\//i.test(ua)) return 'Desktop app';
  // Android WebView (the mobile app) also says "Chrome".
  if (/; wv\)/i.test(ua)) return 'App';
  if (/EdgA?\/|Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS/i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  // WebView shells (the mobile app) carry AppleWebKit without a browser token.
  if (/AppleWebKit/i.test(ua)) return 'App';
  return UNKNOWN;
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  const raw = (ua ?? '').trim();
  if (!raw) return { device: 'Unknown device', browser: UNKNOWN, os: UNKNOWN };
  const { os, device } = detectOs(raw);
  return { device, browser: detectBrowser(raw), os };
}
