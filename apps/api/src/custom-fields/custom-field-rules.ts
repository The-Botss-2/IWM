/**
 * Pure checks for custom field values, kept free of Prisma calls so
 * `scripts/check-client-hub.ts` can run them without a database.
 */

/** Scopes whose values are written through the generic value routes. CLIENT
 *  and LEAD values hang off records with their own visibility rules, so they
 *  go through routes that check those (e.g. /clients/:id/custom-fields). */
export const GENERIC_VALUE_SCOPES = ['PROJECT', 'TASK'] as const;

export function isGenericValueScope(scope: string): boolean {
  return (GENERIC_VALUE_SCOPES as readonly string[]).includes(scope);
}

function optionValues(options: unknown): Set<string> {
  if (!Array.isArray(options)) return new Set();
  return new Set(
    options
      .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
      .filter((v): v is string => typeof v === 'string'),
  );
}

/**
 * Why `value` is not acceptable for a field of this type and options, or
 * null when it is. `null` always clears a value and is always acceptable.
 * USER values are only shape-checked here; that the id is a staff member of
 * the workspace needs the database and is checked by the service.
 */
export function customFieldValueProblem(
  type: string,
  options: unknown,
  value: unknown,
): string | null {
  if (value === null) return null;
  switch (type) {
    case 'TEXT':
    case 'URL':
    case 'USER':
      return typeof value === 'string' ? null : `Value does not match field type ${type}.`;
    case 'DATE':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? null
        : 'Value must be a date.';
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `Value does not match field type ${type}.`;
    case 'CHECKBOX':
      return typeof value === 'boolean' ? null : `Value does not match field type ${type}.`;
    case 'SELECT': {
      if (typeof value !== 'string') return `Value does not match field type ${type}.`;
      return optionValues(options).has(value) ? null : 'Value is not one of the field options.';
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return `Value does not match field type ${type}.`;
      }
      const allowed = optionValues(options);
      return value.every((v) => allowed.has(v)) ? null : 'Value is not one of the field options.';
    }
    default:
      return `Unsupported field type ${type}.`;
  }
}
