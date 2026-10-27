'use client';

import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CustomFieldDefinition } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import {
  type CustomFieldPayload,
  dateFromValue,
  dateToValue,
  parseTextInput,
  safeHref,
  stringList,
  textInputValue,
  toggleInList,
} from '@/lib/custom-field-values';

const NONE = '__none__';

/**
 * One editable custom field (client or task): the input that fits its type.
 * Text-like fields keep local state and save on blur or Enter; the others
 * save on change. `onSave(null)` clears the value.
 */
export function CustomFieldControl({
  idPrefix,
  field,
  readOnly,
  onSave,
}: {
  /** Prefix for element ids, unique per surface (e.g. "task-cf"). */
  idPrefix: string;
  field: { definition: CustomFieldDefinition; value: CustomFieldPayload };
  readOnly: boolean;
  onSave: (value: CustomFieldPayload) => void;
}) {
  const { definition: def, value } = field;
  const id = `${idPrefix}-${def.id}`;
  const label = (
    <Label htmlFor={id}>
      {def.name}
      {def.required ? (
        <span className="ml-0.5 text-state-error" aria-label="required">
          *
        </span>
      ) : null}
    </Label>
  );

  switch (def.type) {
    case 'CHECKBOX':
      return (
        <div className="flex items-center gap-2 self-end py-2">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={readOnly}
            onCheckedChange={(v) => onSave(v === true)}
          />
          {label}
        </div>
      );
    case 'DATE':
      return (
        <div className="space-y-1.5">
          {label}
          <DatePicker
            id={id}
            value={dateFromValue(value)}
            disabled={readOnly}
            onChange={(d) => onSave(dateToValue(d))}
          />
        </div>
      );
    case 'SELECT':
      return (
        <div className="space-y-1.5">
          {label}
          <Select
            value={typeof value === 'string' && value ? value : NONE}
            disabled={readOnly}
            onValueChange={(v) => onSave(v === NONE ? null : v)}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not set</SelectItem>
              {(def.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case 'MULTI_SELECT':
      return <MultiSelectField id={id} def={def} value={value} readOnly={readOnly} onSave={onSave} />;
    case 'USER':
      return (
        <div className="space-y-1.5">
          {label}
          <WorkspaceMembersCombobox
            value={typeof value === 'string' && value ? value : null}
            disabled={readOnly}
            placeholder="Pick a person"
            onChange={(userId) => onSave(userId)}
          />
        </div>
      );
    default:
      return (
        <TextField
          id={id}
          label={label}
          type={def.type}
          value={value}
          readOnly={readOnly}
          onSave={onSave}
        />
      );
  }
}

function MultiSelectField({
  id,
  def,
  value,
  readOnly,
  onSave,
}: {
  id: string;
  def: CustomFieldDefinition;
  value: CustomFieldPayload;
  readOnly: boolean;
  onSave: (value: CustomFieldPayload) => void;
}) {
  const selected = stringList(value);
  const options = def.options ?? [];
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-ink">
        {def.name}
        {def.required ? <span className="ml-0.5 text-state-error">*</span> : null}
      </legend>
      {options.length === 0 ? (
        <p className="text-sm text-ink-muted">No options defined.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
          {options.map((o) => {
            const optId = `${id}-${o.value}`;
            return (
              <div key={o.value} className="flex items-center gap-2">
                <Checkbox
                  id={optId}
                  checked={selected.includes(o.value)}
                  disabled={readOnly}
                  onCheckedChange={(v) => onSave(toggleInList(selected, o.value, v === true))}
                />
                <Label htmlFor={optId} className="font-normal">
                  {o.label}
                </Label>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Text, number and link fields: local state while typing, saved on blur or
 * Enter, so a cache update never overwrites what is still being typed.
 */
function TextField({
  id,
  label,
  type,
  value,
  readOnly,
  onSave,
}: {
  id: string;
  label: ReactNode;
  type: CustomFieldDefinition['type'];
  value: CustomFieldPayload;
  readOnly: boolean;
  onSave: (value: CustomFieldPayload) => void;
}) {
  const upstream = textInputValue(value);
  const [local, setLocal] = useState(upstream);
  const [error, setError] = useState<string | null>(null);
  const upstreamRef = useRef(upstream);

  useEffect(() => {
    if (upstream !== upstreamRef.current) {
      upstreamRef.current = upstream;
      setLocal(upstream);
    }
  }, [upstream]);

  const commit = () => {
    if (local.trim() === upstream.trim()) {
      setError(null);
      return;
    }
    const parsed = parseTextInput(type, local);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onSave(parsed.value);
  };

  const href = type === 'URL' ? safeHref(value) : null;
  const errorId = `${id}-error`;

  return (
    <div className="space-y-1.5">
      {label}
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type={type === 'NUMBER' ? 'number' : type === 'URL' ? 'url' : 'text'}
          inputMode={type === 'NUMBER' ? 'decimal' : undefined}
          value={local}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={type === 'URL' ? 'https://' : undefined}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={readOnly ? undefined : commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        {href ? (
          <Button asChild variant="ghost" size="icon" aria-label="Open link in a new tab">
            <a href={href} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          </Button>
        ) : null}
        {!readOnly && upstream ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear value"
            onClick={() => {
              setLocal('');
              setError(null);
              onSave(null);
            }}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-state-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
