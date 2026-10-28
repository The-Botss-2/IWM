'use client';

import { X } from 'lucide-react';
import { useCallback, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

export function TagInput({
  value,
  onChange,
  placeholder = 'Add tag…',
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: Props) {
  const [draft, setDraft] = useState('');

  const commit = useCallback(
    (raw: string) => {
      const tag = raw.trim();
      if (!tag) return;
      if (value.includes(tag)) {
        setDraft('');
        return;
      }
      onChange([...value, tag]);
      setDraft('');
    },
    [value, onChange],
  );

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      // Pop the last chip when the user backspaces an empty input.
      removeAt(value.length - 1);
    }
  };

  return (
    <div
      className={cn(
        'border-line flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border bg-white px-2 py-1.5 transition-all',
        'focus-within:border-brand-purple focus-within:shadow-focus',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {value.map((tag, idx) => (
        <span
          key={`${tag}-${idx}`}
          className="bg-bg-subtle text-ink inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => removeAt(idx)}
            className="text-ink-muted hover:text-ink focus-visible:shadow-focus rounded p-0.5 focus-visible:outline-none"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        disabled={disabled}
        aria-label={ariaLabel}
        className="placeholder:text-ink-disabled min-w-[100px] flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}
