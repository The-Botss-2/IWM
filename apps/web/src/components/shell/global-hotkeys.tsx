'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useSalesAccess } from '@/hooks/use-sales-access';

/**
 * Workspace-wide hotkey listener. Bound chord shortcuts ("g" followed by
 * another key within 1 s) navigate between top-level routes. Bare keys never
 * fire while focus is in a text-input, textarea, or contenteditable surface so
 * we don't hijack typing.
 *
 * Cmd/Ctrl+K is owned by the CommandPalette component - not here.
 */
const CHORD_TIMEOUT_MS = 1000;

const CHORDS: Record<string, string> = {
  'g d': '/dashboard',
  'g p': '/projects',
  'g o': '/documents',
  'g m': '/mail',
  'g s': '/settings',
};

/** Chords that only bind when the user actually has that sales section. */
const SALES_CHORDS: Record<string, { section: 'leads' | 'clients'; href: string }> = {
  'g l': { section: 'leads', href: '/leads' },
  'g c': { section: 'clients', href: '/clients' },
};

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

export function GlobalHotkeys() {
  const router = useRouter();
  const sales = useSalesAccess();
  const prefixRef = useRef<{ key: string; expires: number } | null>(null);
  const salesLeads = sales.leads;
  const salesClients = sales.clients;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInput(e.target)) return;

      const now = Date.now();
      const prev = prefixRef.current;
      if (prev && now > prev.expires) prefixRef.current = null;

      if (!prefixRef.current && e.key === 'g') {
        prefixRef.current = { key: 'g', expires: now + CHORD_TIMEOUT_MS };
        return;
      }
      if (prefixRef.current) {
        const chord = `${prefixRef.current.key} ${e.key.toLowerCase()}`;
        prefixRef.current = null;
        // A sales chord only navigates when that section is actually available
        // to this user - otherwise the page would just bounce back to /home.
        const sales = SALES_CHORDS[chord];
        const dest = sales
          ? (sales.section === 'leads' ? salesLeads : salesClients)
            ? sales.href
            : undefined
          : CHORDS[chord];
        if (dest) {
          e.preventDefault();
          router.push(dest);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, salesLeads, salesClients]);

  return null;
}
