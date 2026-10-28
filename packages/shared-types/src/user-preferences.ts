import { z } from 'zod';

/* eslint-disable @typescript-eslint/no-redeclare */

/**
 * Per-user UI preferences that follow a person to every device they sign in
 * on (web, the Tauri desktop shell and the mobile WebView shell all load the
 * same Next.js app). Covers Settings -> Appearance and Settings -> Navigation.
 *
 * ## Compatibility rules
 *
 * - Every field is optional. A PATCH carries only what changed, and a client
 *   built before a field existed simply never sends or reads it.
 * - Unknown keys are stripped (Zod's default), so a newer client cannot park
 *   arbitrary JSON in the row.
 * - The stored document is read through {@link parseStoredUserPreferences},
 *   which drops individual invalid values instead of failing the whole read,
 *   so a value written by a newer build (say a theme this build does not know)
 *   degrades to "unset" rather than a 500.
 * - `version` is bumped only for a breaking reshape; the server migrates old
 *   documents on read when that happens.
 */
export const USER_PREFERENCES_VERSION = 1 as const;

export const AppTheme = z.enum(['light', 'dark', 'system']);
export type AppTheme = z.infer<typeof AppTheme>;

export const AppBodyMode = z.enum(['solid', 'gradient']);
export type AppBodyMode = z.infer<typeof AppBodyMode>;

export const AppUiScale = z.enum(['sm', 'md', 'lg', 'xl']);
export type AppUiScale = z.infer<typeof AppUiScale>;

export const AppNavLayout = z.enum(['topbar', 'rail']);
export type AppNavLayout = z.infer<typeof AppNavLayout>;

/** Gradient preset ids are a client-side catalogue (`GRADIENT_PRESETS`); the
 *  server only bounds the shape so an unknown id falls back to the default. */
const presetId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'Must be a lowercase preset id.');

/** Navigation destination id from the web nav registry (`home`, `projects`, ...). */
export const navDestinationId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'Must be a lowercase destination id.');

export const MAX_HIDDEN_NAV_IDS = 64;

/** Settings -> Appearance. */
export const appearancePreferencesSchema = z.object({
  theme: AppTheme.optional(),
  gradientId: presetId.optional(),
  bodyMode: AppBodyMode.optional(),
  uiScale: AppUiScale.optional(),
});
export type AppearancePreferences = z.infer<typeof appearancePreferencesSchema>;

/** Settings -> Navigation (plus the rail's panel toggle). */
export const navigationPreferencesSchema = z.object({
  /** Which chrome wraps the app: the top bar or the side rail. */
  layout: AppNavLayout.optional(),
  /** Rail layout only: the contextual panel is collapsed to the icon rail. */
  panelCollapsed: z.boolean().optional(),
  /** Destinations the user hid. Stored as the HIDDEN set so anything new is
   *  visible by default. Replaced wholesale on update, never merged. */
  hidden: z.array(navDestinationId).max(MAX_HIDDEN_NAV_IDS).optional(),
});
export type NavigationPreferences = z.infer<typeof navigationPreferencesSchema>;

export const userPreferencesSchema = z.object({
  appearance: appearancePreferencesSchema.optional(),
  navigation: navigationPreferencesSchema.optional(),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userPreferencesResponseSchema = z.object({
  version: z.literal(USER_PREFERENCES_VERSION),
  preferences: userPreferencesSchema,
  /** When the server copy was last written; null when the user has never
   *  saved preferences server-side (clients use this to upload a local copy
   *  once). */
  updatedAt: z.coerce.date().nullable(),
});
export type UserPreferencesResponse = z.infer<typeof userPreferencesResponseSchema>;

function pickValid<S extends z.ZodRawShape>(
  shape: S,
  raw: unknown,
): Partial<{ [K in keyof S]: z.infer<S[K]> }> {
  const out: Partial<{ [K in keyof S]: z.infer<S[K]> }> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(shape) as Array<keyof S & string>) {
    if (source[key] === undefined) continue;
    const parsed = (shape[key] as z.ZodTypeAny).safeParse(source[key]);
    if (parsed.success && parsed.data !== undefined) {
      out[key] = parsed.data as z.infer<S[typeof key]>;
    }
  }
  return out;
}

/**
 * Lenient read of a stored preferences document. Drops each invalid value on
 * its own (and invalid ids out of `navigation.hidden`) instead of rejecting
 * the document, and never throws. The result always satisfies
 * {@link userPreferencesSchema}.
 */
export function parseStoredUserPreferences(raw: unknown): UserPreferences {
  const doc =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: UserPreferences = {};

  const appearance = pickValid(appearancePreferencesSchema.shape, doc.appearance);
  if (Object.keys(appearance).length > 0) out.appearance = appearance;

  const navRaw =
    doc.navigation && typeof doc.navigation === 'object' && !Array.isArray(doc.navigation)
      ? (doc.navigation as Record<string, unknown>)
      : undefined;
  const { layout, panelCollapsed } = navigationPreferencesSchema.shape;
  const navigation: NavigationPreferences = pickValid({ layout, panelCollapsed }, navRaw);
  if (navRaw && Array.isArray(navRaw.hidden)) {
    const ids = new Set<string>();
    for (const v of navRaw.hidden) {
      if (navDestinationId.safeParse(v).success) ids.add(v as string);
    }
    navigation.hidden = [...ids].slice(0, MAX_HIDDEN_NAV_IDS);
  }
  if (Object.keys(navigation).length > 0) out.navigation = navigation;

  return out;
}
