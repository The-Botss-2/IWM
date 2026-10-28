'use client';

import { Checkbox } from '@/components/ui/checkbox';
import type { PermissionGroup } from '@/hooks/use-roles';

/** Grouped permission checkboxes for the role editor. Read-only for presets. */
export function PermissionChecklist({
  groups,
  value,
  onToggle,
  readOnly = false,
}: {
  groups: PermissionGroup[];
  value: string[];
  onToggle?: (key: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <fieldset key={g.group} className="space-y-2">
          <legend className="text-ink-muted text-[11px] font-semibold uppercase tracking-wide">
            {g.group}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {g.permissions.map((p) => (
              <label
                key={p.key}
                className="border-line flex cursor-pointer items-start gap-2 rounded-md border p-2.5 has-[:disabled]:cursor-default"
              >
                <Checkbox
                  checked={value.includes(p.key)}
                  onCheckedChange={() => onToggle?.(p.key)}
                  disabled={readOnly}
                  className="mt-0.5"
                  aria-label={p.label}
                />
                <span className="min-w-0 text-sm">
                  <span className="text-ink block font-medium">{p.label}</span>
                  {p.description ? (
                    <span className="text-ink-muted mt-0.5 block text-[11px]">{p.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
