'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@botss/api-client';
import {
  parseStoredUserPreferences,
  type UserPreferences,
  type UserPreferencesResponse,
} from '@botss/shared-types';

import {
  NAV_USER_CHANGE_EVT,
  type NavUserChangeDetail,
  readNavHidden,
  replaceNavHidden,
} from '@/hooks/use-nav-prefs';
import { getApi } from '@/lib/api';
import {
  type AppAppearance,
  APPEARANCE_USER_CHANGE_EVT,
  claimAppearanceFor,
  getAppAppearance,
  replaceAppAppearance,
} from '@/lib/app-prefs';
import { sessionQueryOptions } from '@/lib/session-query';
import { toastError } from '@/lib/toast';
import {
  appearanceChangeToPatch,
  hiddenChangeToPatch,
  isEmptyPatch,
  localGapsForServer,
  mergePatches,
  serverToLocal,
} from '@/lib/user-prefs-sync';

/** Coalesce rapid clicks (theme, then gradient, then scale) into one PATCH. */
const SAVE_DEBOUNCE_MS = 700;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** Per device + user: has this device's pre-sync setup been offered to the server? */
const migratedKey = (userId: string) => `botss.prefs.migrated.${userId}`;

function isMigrated(userId: string): boolean {
  try {
    return window.localStorage.getItem(migratedKey(userId)) === '1';
  } catch {
    return true; // No storage: nothing local worth migrating either.
  }
}

function markMigrated(userId: string): void {
  try {
    window.localStorage.setItem(migratedKey(userId), '1');
  } catch {
    // Non-fatal; the gap upload is idempotent.
  }
}

const userPreferencesKey = (userId: string) => ['me', 'preferences', userId] as const;

/** A 4xx that retrying cannot fix (bad payload, signed out). */
/**
 * Tell the user a save was rejected for good. A 401 is the sign-out race
 * (the unmount flush after the session ended) and stays quiet.
 */
function reportPermanentFailure(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) return;
  toastError(err, "Couldn't save your preferences");
}

function isPermanent(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 409 &&
    err.status !== 429
  );
}

/**
 * Keeps Settings -> Appearance / Navigation in step with the signed-in user's
 * server copy, so they follow the person to every device. Mount once inside
 * the authenticated shell.
 *
 * - **First paint** is unchanged: `ThemePreScript` paints from the localStorage
 *   cache before hydration. This hook binds that cache to the session user
 *   (resetting it if it belonged to someone else), then reconciles with the
 *   server when the query lands.
 * - **Server is the source of truth.** Its value overwrites the cache, unless
 *   the user has local edits waiting to save - those win until their PATCH
 *   returns, and the PATCH response (the merged server doc) is then applied.
 * - **Edits are optimistic.** The settings pages write the cache and apply
 *   instantly; this hook hears the user-change events and PATCHes the delta,
 *   debounced, retrying transient failures with backoff.
 * - **One-time migration.** The first time a device syncs for a user, any
 *   customised local value the server does not have yet is uploaded, so
 *   existing setups survive the move to server storage.
 */
export function useUserPreferencesSync(): void {
  const qc = useQueryClient();
  const session = useQuery(sessionQueryOptions);
  const user = session.data?.user;
  const userId = user && user.accountType !== 'CLIENT' ? user.id : null;

  const prefs = useQuery({
    queryKey: userPreferencesKey(userId ?? ''),
    queryFn: () => getApi().users.preferences(),
    enabled: !!userId,
    staleTime: 60_000,
    // Picks up a change made on another device when this one regains focus.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const pending = useRef<UserPreferences | null>(null);
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);

  // Bind the device cache to this user before anything is reconciled.
  useEffect(() => {
    if (userId) claimAppearanceFor(userId);
  }, [userId]);

  // Collect user-initiated edits and save them.
  useEffect(() => {
    if (!userId) return;
    const key = userPreferencesKey(userId);
    const api = getApi();

    const flush = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (isEmptyPatch(pending.current)) return;
      // Lenient re-parse drops any value the server would reject, so one bad
      // cached value cannot wedge every later save on a 400.
      const body = parseStoredUserPreferences(pending.current);
      pending.current = null;
      inFlight.current += 1;
      api.users
        .updatePreferences(body)
        .then((res: UserPreferencesResponse) => {
          failures.current = 0;
          inFlight.current -= 1;
          qc.setQueryData(key, res);
        })
        .catch((err: unknown) => {
          inFlight.current -= 1;
          if (isPermanent(err)) {
            // Rejected for good: this device keeps its local copy only.
            reportPermanentFailure(err);
            return;
          }
          // Keep the unsaved delta under any newer edits and try again later.
          pending.current = mergePatches(body, pending.current ?? {});
          failures.current += 1;
          schedule(Math.min(RETRY_BASE_MS * 2 ** (failures.current - 1), RETRY_MAX_MS));
        });
    };

    const schedule = (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    };

    const enqueue = (patch: UserPreferences) => {
      if (isEmptyPatch(patch)) return;
      pending.current = mergePatches(pending.current, patch);
      schedule(SAVE_DEBOUNCE_MS);
    };

    const onAppearance = (e: Event) => {
      const change = (e as CustomEvent<Partial<AppAppearance>>).detail;
      if (change) enqueue(appearanceChangeToPatch(change));
    };
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<NavUserChangeDetail>).detail;
      if (detail && detail.userId === userId) enqueue(hiddenChangeToPatch(detail.hidden));
    };
    // Don't sit on an unsaved edit when the app is backgrounded or closed
    // (desktop tray, mobile app switch).
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener(APPEARANCE_USER_CHANGE_EVT, onAppearance);
    window.addEventListener(NAV_USER_CHANGE_EVT, onNav);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener(APPEARANCE_USER_CHANGE_EVT, onAppearance);
      window.removeEventListener(NAV_USER_CHANGE_EVT, onNav);
      document.removeEventListener('visibilitychange', onHide);
      // Best effort on unmount / user switch; harmless 401 after sign-out.
      flush();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      failures.current = 0;
    };
  }, [userId, qc]);

  // Reconcile with the server copy whenever it arrives or changes.
  const data = prefs.data;
  useEffect(() => {
    if (!userId || !data) return;
    // Local edits are newer than this snapshot; the PATCH response will land
    // as fresh query data and re-run this effect.
    if (!isEmptyPatch(pending.current) || inFlight.current > 0) return;

    if (!isMigrated(userId)) {
      markMigrated(userId);
      const gaps = localGapsForServer(
        { appearance: getAppAppearance(), hidden: readNavHidden(userId) },
        data.preferences,
      );
      if (!isEmptyPatch(gaps)) {
        // Upload first and apply nothing yet, so the server snapshot cannot
        // momentarily revert the values being uploaded. The response is the
        // merged document and re-runs this effect.
        inFlight.current += 1;
        getApi()
          .users.updatePreferences(parseStoredUserPreferences(gaps))
          .then((res) => {
            inFlight.current -= 1;
            qc.setQueryData(userPreferencesKey(userId), res);
          })
          .catch((err: unknown) => {
            inFlight.current -= 1;
            if (isPermanent(err)) reportPermanentFailure(err);
            // Let a later visit try again.
            try {
              window.localStorage.removeItem(migratedKey(userId));
            } catch {
              // Ignore; nothing else depends on it.
            }
          });
        return;
      }
    }

    const local = serverToLocal(data.preferences);
    replaceAppAppearance(local.appearance);
    replaceNavHidden(userId, local.hidden);
  }, [userId, data, qc]);
}
