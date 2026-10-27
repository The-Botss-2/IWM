import { format, isValid, parseISO } from 'date-fns';
import type { CustomFieldDefinition, CustomFieldValue } from '@botss/shared-types';

/**
 * Custom field values: the stored payload <-> what an input shows, and the
 * read-only text a table cell renders. Shared by the client, task and list
 * view surfaces.
 */

export type CustomFieldPayload = CustomFieldValue['value'];

export function isEmptyValue(value: CustomFieldPayload): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Text shown in a text, number or URL input. */
export function textInputValue(value: CustomFieldPayload): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * Turn what was typed into the stored payload. Returns `{ error }` when the
 * text cannot be stored for this field type.
 */
export function parseTextInput(
  type: CustomFieldDefinition['type'],
  raw: string,
): { value: CustomFieldPayload } | { error: string } {
  const text = raw.trim();
  if (!text) return { value: null };
  if (type === 'NUMBER') {
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
  }
  if (type === 'URL') {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    try {
      new URL(withScheme);
      return { value: withScheme };
    } catch {
      return { error: 'Enter a valid link.' };
    }
  }
  return { value: text };
}

/** A stored DATE value ('yyyy-MM-dd' or ISO) as a local Date. */
export function dateFromValue(value: CustomFieldPayload): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

/** A picked date as the stored DATE value (calendar day, no time zone). */
export function dateToValue(date: Date | null): CustomFieldPayload {
  return date ? format(date, 'yyyy-MM-dd') : null;
}

export function stringList(value: CustomFieldPayload): string[] {
  return Array.isArray(value) ? value : [];
}

export function toggleInList(list: string[], item: string, on: boolean): string[] {
  const without = list.filter((v) => v !== item);
  return on ? [...without, item] : without;
}

/** Safe external link for a URL value, or null when it is not http(s). */
export function safeHref(value: CustomFieldPayload): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * One-line, read-only text for a value (a list-view cell). Option values
 * show their labels; a USER value shows `userName(id)` when known. Empty
 * values are ''.
 */
export function formatCustomFieldValue(
  definition: Pick<CustomFieldDefinition, 'type' | 'options'>,
  value: CustomFieldPayload | undefined,
  userName?: (id: string) => string | undefined,
): string {
  if (value === undefined || isEmptyValue(value)) return '';
  const label = (v: string) => definition.options?.find((o) => o.value === v)?.label ?? v;
  switch (definition.type) {
    case 'CHECKBOX':
      return value === true ? 'Yes' : value === false ? 'No' : '';
    case 'DATE': {
      const d = dateFromValue(value);
      return d ? d.toLocaleDateString() : '';
    }
    case 'SELECT':
      return typeof value === 'string' ? label(value) : '';
    case 'MULTI_SELECT':
      return stringList(value).map(label).join(', ');
    case 'USER':
      return typeof value === 'string' ? (userName?.(value) ?? 'Someone') : '';
    case 'NUMBER':
      return typeof value === 'number' ? value.toLocaleString() : textInputValue(value);
    default:
      return textInputValue(value);
  }
}
