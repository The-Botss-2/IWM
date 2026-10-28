import { MAX_HIDDEN_NAV_IDS, navDestinationId, type UserPreferences } from '@botss/shared-types';

import { type AppAppearance, DEFAULT_APPEARANCE } from './app-prefs';

/**
 * Pure mapping between this device's two local caches (the appearance blob in
 * `app-prefs.ts` and the per-user hidden-nav list in `use-nav-prefs.ts`) and
 * the server's per-user preferences document. No I/O here; the orchestration
 * lives in `useUserPreferencesSync`.
 *
 * Local -> server key map:
 *   appearance.theme / gradientId / bodyMode / uiScale -> appearance.*
 *   appearance.navLayout          -> navigation.layout
 *   appearance.navPanelCollapsed  -> navigation.panelCollapsed
 *   nav hidden list               -> navigation.hidden
 */

export interface LocalPrefs {
  appearance: AppAppearance;
  hidden: string[];
}

/** Translate a user-initiated appearance change into a server patch. */
export function appearanceChangeToPatch(change: Partial<AppAppearance>): UserPreferences {
  const patch: UserPreferences = {};
  const appearance: NonNullable<UserPreferences['appearance']> = {};
  if (change.theme !== undefined) appearance.theme = change.theme;
  if (change.gradientId !== undefined) appearance.gradientId = change.gradientId;
  if (change.bodyMode !== undefined) appearance.bodyMode = change.bodyMode;
  if (change.uiScale !== undefined) appearance.uiScale = change.uiScale;
  const navigation: NonNullable<UserPreferences['navigation']> = {};
  if (change.navLayout !== undefined) navigation.layout = change.navLayout;
  if (change.navPanelCollapsed !== undefined) {
    navigation.panelCollapsed = change.navPanelCollapsed;
  }
  if (Object.keys(appearance).length > 0) patch.appearance = appearance;
  if (Object.keys(navigation).length > 0) patch.navigation = navigation;
  return patch;
}

/** Hidden-nav change as a patch. Drops ids the server would reject (a
 *  hand-edited cache must not wedge every later save on a 400). */
export function hiddenChangeToPatch(hidden: string[]): UserPreferences {
  const valid = [...new Set(hidden)].filter((id) => navDestinationId.safeParse(id).success);
  return { navigation: { hidden: valid.slice(0, MAX_HIDDEN_NAV_IDS) } };
}

/** Combine two pending patches; later keys win, sections merge, arrays replace. */
export function mergePatches(a: UserPreferences | null, b: UserPreferences): UserPreferences {
  if (!a) return b;
  const out: UserPreferences = {};
  if (a.appearance || b.appearance) out.appearance = { ...a.appearance, ...b.appearance };
  if (a.navigation || b.navigation) out.navigation = { ...a.navigation, ...b.navigation };
  return out;
}

export function isEmptyPatch(p: UserPreferences | null): boolean {
  if (!p) return true;
  return (
    Object.keys(p.appearance ?? {}).length === 0 && Object.keys(p.navigation ?? {}).length === 0
  );
}

/**
 * The server document as local values. Keys the server does not have fall
 * back to defaults: once a user has a server copy it is authoritative, so a
 * key reset elsewhere resets here too.
 */
export function serverToLocal(prefs: UserPreferences): LocalPrefs {
  const a = prefs.appearance ?? {};
  const n = prefs.navigation ?? {};
  return {
    appearance: {
      theme: a.theme ?? DEFAULT_APPEARANCE.theme,
      gradientId: a.gradientId ?? DEFAULT_APPEARANCE.gradientId,
      bodyMode: a.bodyMode ?? DEFAULT_APPEARANCE.bodyMode,
      uiScale: a.uiScale ?? DEFAULT_APPEARANCE.uiScale,
      navLayout: n.layout ?? DEFAULT_APPEARANCE.navLayout,
      navPanelCollapsed: n.panelCollapsed ?? DEFAULT_APPEARANCE.navPanelCollapsed,
    },
    hidden: n.hidden ? [...n.hidden] : [],
  };
}

/**
 * One-time upload of this device's setup. Returns only the locally customised
 * (non-default) values the server does not already hold, so:
 * - a fresh device with defaults uploads nothing and cannot wipe a setup made
 *   on another device, and
 * - two devices customised before sync shipped contribute the union of their
 *   choices, with whichever synced first winning any key both set.
 */
export function localGapsForServer(local: LocalPrefs, server: UserPreferences): UserPreferences {
  const sa = server.appearance ?? {};
  const sn = server.navigation ?? {};
  const la = local.appearance;
  const change: Partial<AppAppearance> = {};
  if (sa.theme === undefined && la.theme !== DEFAULT_APPEARANCE.theme) change.theme = la.theme;
  if (sa.gradientId === undefined && la.gradientId !== DEFAULT_APPEARANCE.gradientId) {
    change.gradientId = la.gradientId;
  }
  if (sa.bodyMode === undefined && la.bodyMode !== DEFAULT_APPEARANCE.bodyMode) {
    change.bodyMode = la.bodyMode;
  }
  if (sa.uiScale === undefined && la.uiScale !== DEFAULT_APPEARANCE.uiScale) {
    change.uiScale = la.uiScale;
  }
  if (sn.layout === undefined && la.navLayout !== DEFAULT_APPEARANCE.navLayout) {
    change.navLayout = la.navLayout;
  }
  if (
    sn.panelCollapsed === undefined &&
    la.navPanelCollapsed !== DEFAULT_APPEARANCE.navPanelCollapsed
  ) {
    change.navPanelCollapsed = la.navPanelCollapsed;
  }
  const patch = appearanceChangeToPatch(change);
  if (sn.hidden === undefined && local.hidden.length > 0) {
    return mergePatches(patch, hiddenChangeToPatch(local.hidden));
  }
  return patch;
}
