'use client';

import type { PermissionOverrideDto } from '@botss/shared-types';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type OverrideState,
  type PermissionGroup,
  overrideStateOf,
  withOverride,
} from '@/hooks/use-roles';

/**
 * Per-person extras: each permission is inherited from the role, granted, or
 * denied. `fromRole` marks what the role already gives, so "Inherit" reads
 * as on or off.
 */
export function OverrideEditor({
  groups,
  overrides,
  fromRole,
  onChange,
  allowed,
}: {
  groups: PermissionGroup[];
  overrides: PermissionOverrideDto[];
  fromRole: string[];
  onChange: (next: PermissionOverrideDto[]) => void;
  /** When set, only these keys may be changed (workspace managers). */
  allowed?: string[];
}) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <fieldset key={g.group} className="space-y-1.5">
          <legend className="text-ink-muted text-[11px] font-semibold uppercase tracking-wide">
            {g.group}
          </legend>
          {g.permissions.map((p) => {
            const state = overrideStateOf(overrides, p.key);
            const locked = !!allowed && !allowed.includes(p.key);
            return (
              <div
                key={p.key}
                className="border-line flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="min-w-0 text-sm">
                  <span className="text-ink block font-medium">{p.label}</span>
                  <span className="text-ink-muted block text-[11px]">
                    Role: {fromRole.includes(p.key) ? 'allowed' : 'not allowed'}
                  </span>
                </span>
                <Select
                  value={state}
                  onValueChange={(v) =>
                    onChange(withOverride(overrides, p.key, v as OverrideState))
                  }
                  disabled={locked}
                >
                  <SelectTrigger className="w-32" aria-label={`${p.label} override`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">From role</SelectItem>
                    <SelectItem value="grant">Allow</SelectItem>
                    <SelectItem value="deny">Deny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
