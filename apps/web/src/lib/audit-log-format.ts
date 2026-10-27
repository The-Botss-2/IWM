import {
  looksLikeAuditId,
  SECURITY_ALERT_ACTIONS,
  type AuditLogEntry,
  type SecurityAlertAction,
} from '@botss/shared-types';

/**
 * Turns an audit row's `target` and free-form `metadata` into readable text.
 * The API resolves ids to names (`targetLabel`, `labels`); this file only
 * picks the right wording so raw ids never reach the screen.
 */

const KIND_LABELS: Record<string, string> = {
  user: 'User',
  contact: 'Portal contact',
  client: 'Client',
  project: 'Project',
  document: 'Document',
  workspace: 'Workspace',
  role: 'Role',
  organization: 'Organization',
};

const UNAVAILABLE = 'No longer available';
/** A target kind the API doesn't name; the record may well still exist. */
const NOT_SHOWN = 'Not shown';

const SECURITY_ALERT_LABELS: Record<SecurityAlertAction, string> = {
  'security.failed_signins': 'Many failed sign-ins',
  'security.mass_delete': 'Mass delete',
  'security.new_admin': 'New admin',
  'security.large_export': 'Large export',
  'security.large_import': 'Large import',
};

const SECURITY_ALERT_SET: ReadonlySet<string> = new Set(SECURITY_ALERT_ACTIONS);

/** Whether the action is a security alert raised by the platform. */
export function isSecurityAlert(action: string): action is SecurityAlertAction {
  return SECURITY_ALERT_SET.has(action);
}

/** Friendly name for a security alert; other actions keep their token. */
export function formatAuditAction(action: string): string {
  return isSecurityAlert(action) ? SECURITY_ALERT_LABELS[action] : action;
}

export interface AuditTargetDisplay {
  kind: string;
  name: string;
  /** False when the record was removed or isn't visible to this org. */
  resolved: boolean;
}

export interface AuditDetail {
  key: string;
  label: string;
  value: string;
}

function humanizeKey(key: string): string {
  const words = key
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function formatAuditTarget(row: AuditLogEntry): AuditTargetDisplay | null {
  if (!row.targetLabel) return null;
  const { type, name } = row.targetLabel;
  // `Object.hasOwn`: a type like "constructor" must not hit Object.prototype.
  const known = Object.hasOwn(KIND_LABELS, type);
  const kind = known ? KIND_LABELS[type]! : humanizeKey(type);
  if (name) return { kind, name, resolved: true };
  return { kind, name: known ? UNAVAILABLE : NOT_SHOWN, resolved: false };
}

function formatValue(value: unknown, labels: Record<string, string>, depth: number): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (Object.hasOwn(labels, value)) return labels[value]!;
    // An id the API couldn't name (record purged); never print the id itself.
    return looksLikeAuditId(value) ? UNAVAILABLE : value;
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'None'
      : value.map((item) => formatValue(item, labels, depth + 1)).join(', ');
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '…';
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${humanizeKey(k)}: ${formatValue(v, labels, depth + 1)}`,
    );
    return parts.length > 0 ? parts.join(', ') : 'None';
  }
  return String(value);
}

export function formatAuditDetails(row: AuditLogEntry): AuditDetail[] {
  return Object.entries(row.metadata).map(([key, value]) => ({
    key,
    label: humanizeKey(key),
    value: formatValue(value, row.labels, 0),
  }));
}
