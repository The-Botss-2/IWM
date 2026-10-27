import { looksLikeAuditId, type AuditTargetLabel } from '@botss/shared-types';

/**
 * Pure helpers that turn the ids stored in audit rows (`target` is
 * `"<type>:<id>"`, `metadata` is free-form JSON) into display names. The
 * database lookups live in `AuditLogService.resolveLabels`; everything here is
 * side-effect free so `scripts/check-audit-log-labels.ts` can test it.
 */

/** Entity kinds the audit log points at, in the order ids are matched. */
export const AUDIT_LABEL_KINDS = [
  'user',
  'contact',
  'client',
  'project',
  'document',
  'workspace',
  'role',
  'organization',
] as const;
export type AuditLabelKind = (typeof AUDIT_LABEL_KINDS)[number];

/** A resolved record: its display name and the organizations it belongs to. */
export interface LabelRecord {
  name: string;
  orgIds: readonly string[];
}

export type LabelLookups = Record<AuditLabelKind, ReadonlyMap<string, LabelRecord>>;

const MAX_DEPTH = 4;

export function parseTarget(target: string | null): { type: string; id: string } | null {
  if (!target) return null;
  const sep = target.indexOf(':');
  if (sep <= 0 || sep === target.length - 1) return null;
  return { type: target.slice(0, sep), id: target.slice(sep + 1) };
}

function isLabelKind(type: string): type is AuditLabelKind {
  return (AUDIT_LABEL_KINDS as readonly string[]).includes(type);
}

/** Every id-shaped string in `metadata`, walking nested objects and arrays. */
export function collectMetadataIds(metadata: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > MAX_DEPTH || metadata === null || metadata === undefined) return out;
  if (typeof metadata === 'string') {
    if (looksLikeAuditId(metadata)) out.add(metadata);
  } else if (Array.isArray(metadata)) {
    for (const item of metadata) collectMetadataIds(item, depth + 1, out);
  } else if (typeof metadata === 'object') {
    for (const value of Object.values(metadata as Record<string, unknown>)) {
      collectMetadataIds(value, depth + 1, out);
    }
  }
  return out;
}

/**
 * Ids to look up for a page of rows. Target ids go to their own kind; ids
 * found in metadata could be any kind, so they are looked up in all of them.
 */
export function collectLookupIds(
  rows: ReadonlyArray<{ target: string | null; metadata: unknown }>,
): { byKind: Record<AuditLabelKind, Set<string>>; untyped: Set<string> } {
  const byKind = Object.fromEntries(
    AUDIT_LABEL_KINDS.map((kind) => [kind, new Set<string>()]),
  ) as Record<AuditLabelKind, Set<string>>;
  const untyped = new Set<string>();
  for (const row of rows) {
    const parsed = parseTarget(row.target);
    if (parsed && isLabelKind(parsed.type)) byKind[parsed.type].add(parsed.id);
    collectMetadataIds(row.metadata, 0, untyped);
  }
  return { byKind, untyped };
}

function lookup(
  lookups: LabelLookups,
  kind: AuditLabelKind,
  id: string,
  organizationId: string,
): string | null {
  const record = lookups[kind].get(id);
  return record && record.orgIds.includes(organizationId) ? record.name : null;
}

/**
 * Labels for one row. A name is only used when the record belongs to the
 * row's organization, so an audit entry can never reveal another tenant's
 * names even if its metadata happens to carry a foreign id.
 */
export function labelRow(
  row: { organizationId: string; target: string | null; metadata: unknown },
  lookups: LabelLookups,
): { targetLabel: AuditTargetLabel | null; labels: Record<string, string> } {
  const labels: Record<string, string> = {};
  const parsed = parseTarget(row.target);
  let targetLabel: AuditTargetLabel | null = null;
  if (parsed) {
    const name = isLabelKind(parsed.type)
      ? lookup(lookups, parsed.type, parsed.id, row.organizationId)
      : null;
    targetLabel = { type: parsed.type, name };
    if (name) labels[parsed.id] = name;
  }
  for (const id of collectMetadataIds(row.metadata)) {
    for (const kind of AUDIT_LABEL_KINDS) {
      const name = lookup(lookups, kind, id, row.organizationId);
      if (name) {
        labels[id] = name;
        break;
      }
    }
  }
  return { targetLabel, labels };
}
