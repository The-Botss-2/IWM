'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';
import type { Holiday } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateHoliday } from '@/hooks/use-holidays';

/**
 * A holiday's name, date and notes, with an inline editor for the name and
 * notes. The date cannot change (the API refuses it: attendance was stamped
 * for that day), so moving a holiday is delete and re-add.
 */
export function HolidayDetails({ holiday }: { holiday: Holiday }) {
  const update = useUpdateHoliday();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(holiday.name);
  const [notes, setNotes] = useState(holiday.notes ?? '');
  const day = new Date(holiday.date).toISOString().slice(0, 10);

  const startEdit = () => {
    setName(holiday.name);
    setNotes(holiday.notes ?? '');
    setEditing(true);
  };

  const save = () => {
    const nextName = name.trim();
    const nextNotes = notes.trim() || null;
    const input = {
      ...(nextName !== holiday.name ? { name: nextName } : {}),
      ...(nextNotes !== (holiday.notes ?? null) ? { notes: nextNotes } : {}),
    };
    if (Object.keys(input).length === 0) {
      setEditing(false);
      return;
    }
    update.mutate({ id: holiday.id, input }, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    const nameId = `holiday-edit-name-${holiday.id}`;
    const notesId = `holiday-edit-notes-${holiday.id}`;
    return (
      <form
        className="min-w-0 flex-1 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={nameId} className="text-[11px]">
              Name
            </Label>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="h-9 text-sm"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={notesId} className="text-[11px]">
              Notes (optional)
            </Label>
            <Input
              id={notesId}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={255}
              className="h-9 text-sm"
            />
          </div>
        </div>
        <p className="text-xs text-ink-muted">
          {day} · the date can&apos;t change. Delete and re-add the holiday to move it.
        </p>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={update.isPending || !name.trim()}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={update.isPending}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-brand-purple" />
        <span className="font-medium text-ink">{holiday.name}</span>
        <span className="text-xs text-ink-muted">{day}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Edit ${holiday.name}`}
          onClick={startEdit}
          className="h-7 w-7 min-h-0 min-w-0"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
      {holiday.notes ? <p className="ml-4 text-xs text-ink-muted">{holiday.notes}</p> : null}
    </div>
  );
}
