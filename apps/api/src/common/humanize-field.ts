/**
 * Turn a machine field name or JSON-pointer path into words a user can read:
 * `/items/0/unitPrice` -> "Unit price", `billing_email` -> "Billing email".
 * The last non-numeric path segment wins; camelCase and snake_case are split
 * and the result is sentence case. Mirrored client-side in
 * `apps/web/src/lib/toast.ts` (`humanizeField`).
 */
export function humanizeField(path: string): string {
  const segments = path.split(/[/.]/).filter((s) => s && !/^\d+$/.test(s));
  const last = segments[segments.length - 1];
  if (!last) return 'Input';
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'Input';
  return words.charAt(0).toUpperCase() + words.slice(1);
}
