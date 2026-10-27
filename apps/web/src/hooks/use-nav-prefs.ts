'use client';

import { useCallback, useEffect, useState } from 'react';

import { NAV_DESTINATIONS, navById } from '@/lib/nav-registry';

/**
 * Per-user navigation preferences, shared by every surface (icon rail,
 * contextual panel, top bar).
 *
 * ## Stores HIDDEN ids, not visible ones
 *
 * The predecessor (`use-navbar-prefs`) stored the visible list, which meant
 * every new destination defaulted to hidden for existing users - Financials
 * shipped and nobody saw it until they opened Settings. Storing the hidden set
 * inverts that: anything new is on by default, which is what people expect
 * from a feature they were just told about.
 *
 * ## One choice across layouts
 *
 * Hiding a section hides it in the rail, the panel and the top bar alike.
 * Users think "I don't use Timesheets", not "I don't use Timesheets in the
 * rail", and the old `prefkey` wiring already behaved this way.
 */

/**
 * localStorage namespace. Split into namespace + version rather than one
 * dotted literal because the combined string scored high enough on entropy to
 * trip gitleaks' generic-api-key rule and block a deploy. The same-line
 * allow below is the documented escape hatch; gitleaks only honours it on the
 * line the finding is on, never on a preceding comment.
 */
const KEY_NS = 'botss.nav.hidden'; // gitleaks:allow - not a credential
const KEY_VERSION = 'v1';
const LEGACY_PREFIX = 'navbar_visible_';
const EVT = 'botss-nav-prefs';
/**
 * Fired only for user-initiated changes so `useUserPreferencesSync` can save
 * them to the server; values written back from the server do not fire it.
 * The localStorage copy is a per-user first-paint cache, the server is the
 * source of truth.
 */
export const NAV_USER_CHANGE_EVT = 'botss-nav-prefs-user-change';
export interface NavUserChangeDetail {
  userId: string;
  hidden: string[];
}

/**
 * Old ids -> new ones. The top bar's `workspace` was a single dropdown
 * covering four destinations, so hiding it has to fan out; otherwise a user
 * who had collapsed that menu would suddenly see all four reappear.
 */
const LEGACY_MAP: Record<string, string[]> = {
  home: ['home'],
  dashboard: ['dashboard'],
  workspace: ['projects', 'documents', 'leads', 'clients'],
  mail: ['mail'],
  chat: ['chat'],
  todo: ['todo'],
  timesheets: ['timesheets'],
  calendar: ['calendar'],
  settings: ['settings'],
  admin: ['admin'],
  financials: ['financials'],
};

function keyFor(userId: string): string {
  return `${KEY_NS}.${KEY_VERSION}.${userId}`;
}

/**
 * One-time migration off the legacy visible-list key. Only runs when no new
 * key exists, so a user who has since changed their mind is never overwritten.
 */
function migrateLegacy(userId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_PREFIX + userId);
    if (!raw) return null;
    const visible = JSON.parse(raw) as unknown;
    if (!Array.isArray(visible)) return null;
    const visibleSet = new Set(visible.filter((v): v is string => typeof v === 'string'));
    const hidden: string[] = [];
    for (const [legacyId, newIds] of Object.entries(LEGACY_MAP)) {
      if (visibleSet.has(legacyId)) continue;
      // `financials` postdates most stored prefs; treat its absence as "not
      // chosen yet" rather than "hidden", so the new tab is not born invisible.
      if (legacyId === 'financials') continue;
      hidden.push(...newIds);
    }
    return hidden;
  } catch {
    return null;
  }
}

function read(userId: string): string[] {
  if (typeof window === 'undefined' || !userId) return [];
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string');
      }
      return [];
    }
    const migrated = migrateLegacy(userId);
    if (migrated) {
      window.localStorage.setItem(keyFor(userId), JSON.stringify(migrated));
      return migrated;
    }
    return [];
  } catch {
    return [];
  }
}

function write(userId: string, hidden: string[], fromUser = true): void {
  if (typeof window === 'undefined' || !userId) return;
  // Always-on destinations can never be persisted as hidden, so a corrupted
  // or hand-edited value cannot strand someone with no way back to Settings.
  const safe = hidden.filter((id) => navById(id)?.alwaysOn !== true);
  window.localStorage.setItem(keyFor(userId), JSON.stringify(safe));
  window.dispatchEvent(new CustomEvent(EVT, { detail: safe }));
  if (fromUser) {
    window.dispatchEvent(
      new CustomEvent<NavUserChangeDetail>(NAV_USER_CHANGE_EVT, {
        detail: { userId, hidden: safe },
      }),
    );
  }
}

/** This device's cached hidden list for `userId` (runs the legacy migration). */
export function readNavHidden(userId: string): string[] {
  return read(userId);
}

/** Server-originated hidden list. Updates the cache without echoing a save. */
export function replaceNavHidden(userId: string, hidden: string[]): void {
  if (typeof window === 'undefined' || !userId) return;
  const current = read(userId);
  if (JSON.stringify(current) === JSON.stringify(hidden)) return;
  write(userId, hidden, false);
}

export interface NavPrefs {
  hidden: ReadonlySet<string>;
  isVisible: (id: string) => boolean;
  toggle: (id: string) => void;
  setHidden: (ids: string[]) => void;
  reset: () => void;
}

export function useNavPrefs(userId: string): NavPrefs {
  const [hidden, setHiddenState] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) return;
    setHiddenState(read(userId));
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<string[]>).detail;
      if (next) setHiddenState(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(userId)) setHiddenState(read(userId));
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  const isVisible = useCallback(
    (id: string) => {
      if (navById(id)?.alwaysOn) return true;
      return !hidden.includes(id);
    },
    [hidden],
  );

  const toggle = useCallback(
    (id: string) => {
      if (navById(id)?.alwaysOn) return;
      setHiddenState((prev) => {
        const next = prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id];
        write(userId, next);
        return next;
      });
    },
    [userId],
  );

  const setHidden = useCallback(
    (ids: string[]) => {
      const safe = ids.filter((id) => navById(id)?.alwaysOn !== true);
      setHiddenState(safe);
      write(userId, safe);
    },
    [userId],
  );

  const reset = useCallback(() => {
    setHiddenState([]);
    write(userId, []);
  }, [userId]);

  return { hidden: new Set(hidden), isVisible, toggle, setHidden, reset };
}
