'use client';

import { useEffect, useRef, useState } from 'react';
import type { ClientDetail } from '@botss/shared-types';

import { Textarea } from '@/components/ui/textarea';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import { useUpdateClient } from '@/hooks/use-clients';

export function ClientNotes({ client }: { client: ClientDetail }) {
  const update = useUpdateClient();
  const [notes, setNotes] = useState(client.notes ?? '');
  const upstreamRef = useRef(client.notes ?? '');

  // External updates (e.g. another tab) reset the field only when the user
  // isn't actively diverging - otherwise the cache patch from our own debounce
  // would clobber the next keystroke.
  useEffect(() => {
    const next = client.notes ?? '';
    if (next !== upstreamRef.current) {
      upstreamRef.current = next;
      setNotes(next);
    }
  }, [client.notes]);

  const debouncedSave = useDebouncedCallback((value: string) => {
    if (value === (client.notes ?? '')) return;
    update.mutate({ id: client.id, input: { notes: value.length === 0 ? undefined : value } });
  }, 800);

  return (
    <section className="space-y-2">
      <h2 className="text-ink text-base font-semibold">Notes</h2>
      <p className="text-ink-muted text-sm">Saves automatically as you type.</p>
      <Textarea
        aria-label="Client notes"
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          debouncedSave(e.target.value);
        }}
        rows={12}
        placeholder="Capture context, contracts, internal status updates…"
      />
    </section>
  );
}
