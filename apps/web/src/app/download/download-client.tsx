'use client';

import { useQuery } from '@tanstack/react-query';
import { Apple, ArrowLeft, Monitor, Smartphone, Terminal, Download } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ComponentType } from 'react';

import { Logo } from '@/components/branding/logo';
import { PageLoader } from '@/components/ui/loader';
import { isAuthFailure, sessionQueryOptions } from '@/lib/session-query';
import { cn } from '@/lib/utils';

type OS = 'windows' | 'mac' | 'linux' | 'android' | 'ios';

const OS_META: Record<
  OS,
  {
    label: string;
    feed: string;
    icon: ComponentType<{ className?: string }>;
    // Desktop installers expose an electron-updater YAML feed; the mobile
    // builds have no such feed, so the release pipeline writes a tiny JSON
    // manifest instead. The loader branches on this.
    kind: 'yaml' | 'json';
  }
> = {
  windows: { label: 'Windows', feed: 'latest.yml', icon: Monitor, kind: 'yaml' },
  mac: { label: 'macOS', feed: 'latest-mac.yml', icon: Apple, kind: 'yaml' },
  linux: { label: 'Linux', feed: 'latest-linux.yml', icon: Terminal, kind: 'yaml' },
  android: { label: 'Android (APK)', feed: 'android-latest.json', icon: Smartphone, kind: 'json' },
  ios: { label: 'iOS (AltStore)', feed: 'ios-latest.json', icon: Apple, kind: 'json' },
};

const OS_ORDER: OS[] = ['windows', 'mac', 'linux', 'android', 'ios'];

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  // iOS first - iPhone/iPad before the mac branch (iPadOS can report "mac").
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  // Android next - it's Linux-based, so check it before the linux branch.
  if (ua.includes('android')) return 'android';
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

type Release = { version: string; url: string };

/**
 * Resolve the current installer for an OS by reading its release feed (a
 * small static file at /releases/). Desktop OSes use the electron-updater
 * YAML feed; Android uses a JSON manifest the mobile release job writes
 * ({ version, path }). These are static assets served by Caddy, not the
 * backend API, so this intentionally bypasses @botss/api-client - there is
 * no typed endpoint for the release feed.
 */
async function loadRelease(
  base: string,
  feed: string,
  kind: 'yaml' | 'json',
): Promise<Release | null> {
  try {
    const res = await fetch(`${base}/${feed}`, { cache: 'no-store' });
    if (!res.ok) return null;
    if (kind === 'json') {
      const data = (await res.json()) as { version?: string; path?: string };
      const version = data.version?.trim();
      const file = data.path?.trim();
      if (!version || !file) return null;
      return { version, url: `${base}/${encodeURIComponent(file)}` };
    }
    const text = await res.text();
    const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/['"]/g, '');
    const file = /^path:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/['"]/g, '');
    if (!version || !file) return null;
    return { version, url: `${base}/${encodeURIComponent(file)}` };
  } catch {
    return null;
  }
}

export function DownloadClient() {
  const router = useRouter();
  // Restrict downloads to signed-in CRM users: the session endpoint 401s for
  // anonymous visitors, which surfaces as an error here and bounces to sign-in.
  const session = useQuery(sessionQueryOptions);
  const authFailed = session.isError && isAuthFailure(session.error);

  // Only a genuine 401/403 bounces to sign-in. A network blip or a deploy
  // restart used to log the visitor out of the download page too.
  useEffect(() => {
    if (authFailed) router.replace('/sign-in');
  }, [authFailed, router]);

  // The desktop app is for CRM staff; a client-portal account goes back to
  // its portal (which works in any browser and the mobile app).
  const isPortalAccount = session.data?.user.accountType === 'CLIENT';
  useEffect(() => {
    if (isPortalAccount) router.replace('/portal');
  }, [isPortalAccount, router]);

  const [primary, setPrimary] = useState<OS>('windows');
  const [releases, setReleases] = useState<Partial<Record<OS, Release | null>>>({});
  const [loading, setLoading] = useState(true);

  const base = useMemo(
    () => (typeof window === 'undefined' ? '' : `${window.location.origin}/releases`),
    [],
  );

  useEffect(() => {
    setPrimary(detectOS());
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        OS_ORDER.map(
          async (os) => [os, await loadRelease(base, OS_META[os].feed, OS_META[os].kind)] as const,
        ),
      );
      if (cancelled) return;
      setReleases(Object.fromEntries(entries));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  const primaryRelease = releases[primary] ?? null;
  const PrimaryIcon = OS_META[primary].icon;

  // Auth gate: render nothing useful until the session resolves; anonymous
  // visitors are redirected to sign-in by the effect above.
  if (!session.data || isPortalAccount) {
    return (
      <PageLoader
        fullScreen
        label={
          authFailed
            ? 'Redirecting to sign-in'
            : isPortalAccount
              ? 'Opening your client portal'
              : 'Loading'
        }
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
      {/* Standalone route (no app shell), so give an explicit way back - the
          mobile WebView has no browser chrome. Prefer history, fall back to the
          app home for direct loads / new-tab opens. */}
      <button
        type="button"
        onClick={() =>
          typeof window !== 'undefined' && window.history.length > 1
            ? router.back()
            : router.push('/home')
        }
        aria-label="Go back"
        className="border-line text-ink shadow-soft hover:bg-bg-subtle fixed left-4 top-4 inline-flex items-center gap-1.5 rounded-full border bg-white/80 px-3 py-1.5 text-sm backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <Logo variant="full" size="md" />

      <h1 className="text-ink mt-8 text-2xl font-semibold">Botss Desktop</h1>
      <p className="text-ink-muted mt-2 text-sm">
        The full Botss workspace in a native window - chat, projects, mail, and calls, with desktop
        notifications and deep links.
      </p>

      {/* Primary CTA for the visitor's detected OS. */}
      <div className="mt-8 w-full">
        {loading ? (
          <div className="bg-bg-subtle h-12 w-full animate-pulse rounded-full" />
        ) : primaryRelease ? (
          <a
            href={primaryRelease.url}
            className="bg-brand-gradient shadow-pill inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <PrimaryIcon className="h-4 w-4" />
            Download for {OS_META[primary].label}
            <span className="text-white/70">v{primaryRelease.version}</span>
          </a>
        ) : (
          <div className="border-line bg-bg-subtle text-ink-muted rounded-xl border px-4 py-3 text-sm">
            No {OS_META[primary].label} build is published yet. Check back soon.
          </div>
        )}
      </div>

      {/* Every platform, so a visitor can grab a build for another machine. */}
      <div className="mt-6 w-full">
        <div className="text-ink-muted mb-2 text-xs font-medium uppercase tracking-wide">
          All platforms
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {OS_ORDER.map((os) => {
            const rel = releases[os] ?? null;
            const Icon = OS_META[os].icon;
            const disabled = loading || !rel;
            return (
              <a
                key={os}
                href={rel?.url ?? undefined}
                aria-disabled={disabled}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                  disabled
                    ? 'border-line bg-bg-subtle text-ink-muted pointer-events-none'
                    : 'border-line text-ink hover:bg-bg-subtle',
                )}
              >
                <Icon className="h-4 w-4" />
                {OS_META[os].label}
                {rel ? <Download className="text-ink-muted h-3.5 w-3.5" /> : null}
              </a>
            );
          })}
        </div>
      </div>

      <p className="text-ink-muted mt-8 max-w-md text-xs">
        The app is unsigned, so the first launch shows a one-time &ldquo;unrecognized app&rdquo;
        warning - choose <strong>More info → Run anyway</strong> (Windows) or right-click →{' '}
        <strong>Open</strong> (macOS). After that it updates itself automatically.
      </p>

      <p className="text-ink-muted mt-6 text-xs">
        On Android? Grab the APK above - you may need to allow installs from this source on the
        first run. The app also ships on the Play Store.
      </p>

      <p className="text-ink-muted mt-3 max-w-md text-xs">
        On iPhone/iPad? The iOS app installs through{' '}
        <a
          href="https://altstore.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-600 font-medium hover:underline"
        >
          AltStore
        </a>{' '}
        (sideloading), not the App Store. Install AltStore on your computer with AltServer, then
        download the <strong>iOS (AltStore)</strong> file above and open it in AltStore to install.
        With a free Apple ID the app needs a refresh every 7 days - AltServer does this
        automatically while it can reach your device on the same Wi-Fi.
      </p>
    </main>
  );
}
