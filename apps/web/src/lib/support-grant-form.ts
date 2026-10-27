import {
  resolveSupportGrantExpiry,
  SUPPORT_GRANT_PRESETS,
  type CreateSupportGrantInput,
  type SupportGrantPreset,
  type SupportGrantStatus,
} from '@botss/shared-types';

/**
 * The Support access form: a preset or a custom end time, turned into the
 * API input. The 30 day cap and "must be in the future" come from the same
 * shared rule the API enforces, so the inline message matches the server.
 */

export type SupportGrantChoice = SupportGrantPreset | 'custom';

export const SUPPORT_GRANT_CHOICES: ReadonlyArray<{ value: SupportGrantChoice; label: string }> = [
  ...SUPPORT_GRANT_PRESETS.map((p) => ({ value: p, label: presetLabel(p) })),
  { value: 'custom', label: 'Custom end time' },
];

function presetLabel(p: SupportGrantPreset): string {
  switch (p) {
    case '1h':
      return '1 hour';
    case '24h':
      return '24 hours';
    case '72h':
      return '72 hours';
  }
}

export type SupportGrantFormResult =
  | { ok: true; input: CreateSupportGrantInput }
  | { ok: false; reason: string };

/** `customEnd` is a `datetime-local` value, read in the browser's time zone. */
export function buildSupportGrantInput(
  choice: SupportGrantChoice,
  customEnd: string,
  reason: string,
  now: Date = new Date(),
): SupportGrantFormResult {
  const note = reason.trim() ? { reason: reason.trim() } : {};
  if (choice !== 'custom') return { ok: true, input: { duration: choice, ...note } };
  if (!customEnd) return { ok: false, reason: 'Pick when support access should end.' };
  const expiresAt = new Date(customEnd);
  const check = resolveSupportGrantExpiry({ expiresAt }, now);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, input: { expiresAt: check.expiresAt, ...note } };
}

export const SUPPORT_GRANT_STATUS_LABEL: Record<SupportGrantStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Ended',
  REVOKED: 'Revoked',
};
