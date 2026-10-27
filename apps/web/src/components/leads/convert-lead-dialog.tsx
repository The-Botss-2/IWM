'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ConvertLeadInput, LeadWithOwner } from '@botss/shared-types';

import { ClientCombobox } from '@/components/clients/client-combobox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useConvertLead } from '@/hooks/use-leads';
import { toast, toastErrorMessage } from '@/lib/toast';

type Mode = 'new' | 'existing';

interface Props {
  lead: LeadWithOwner;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful conversion. Lets the caller close the parent panel. */
  onConverted?: () => void;
}

export function ConvertLeadDialog({ lead, open, onOpenChange, onConverted }: Props) {
  const router = useRouter();
  const convert = useConvertLead();

  const [mode, setMode] = useState<Mode>('new');

  // Editable copy of the lead so the user can tweak before creating the Client.
  const [name, setName] = useState(lead.company ?? lead.name);
  const [email, setEmail] = useState(lead.email ?? '');
  const [phone, setPhone] = useState(lead.phone ?? '');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState(lead.notes ?? '');

  const [existingClientId, setExistingClientId] = useState<string | null>(null);

  // Re-seed defaults when the source lead changes (parent reopens for a different lead).
  useEffect(() => {
    setName(lead.company ?? lead.name);
    setEmail(lead.email ?? '');
    setPhone(lead.phone ?? '');
    setWebsite('');
    setNotes(lead.notes ?? '');
    setExistingClientId(null);
    setMode('new');
  }, [lead.id, lead.company, lead.name, lead.email, lead.phone, lead.notes]);

  const pending = convert.isPending;

  const onSubmit = async () => {
    try {
      let payload: ConvertLeadInput;
      if (mode === 'new') {
        if (name.trim().length === 0) {
          toastErrorMessage('Client name is required');
          return;
        }
        payload = {
          newClient: {
            name: name.trim(),
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            ...(website.trim() ? { website: website.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            // Carry the assignment across so whoever worked the lead keeps
            // seeing the account after it converts.
            ...(lead.assigneeId ? { assigneeId: lead.assigneeId } : {}),
          },
        };
      } else {
        if (!existingClientId) {
          toastErrorMessage('Pick a client to link');
          return;
        }
        payload = { clientId: existingClientId };
      }

      const updated = await convert.mutateAsync({ id: lead.id, input: payload });
      toast.success(
        mode === 'new' ? 'Lead converted to client.' : 'Lead linked to existing client.',
      );
      onConverted?.();
      onOpenChange(false);
      // `updated.convertedToClientId` is the freshly-linked client; navigating
      // there avoids stale state vs. just bouncing to /clients.
      if (updated.convertedToClientId) {
        router.push(`/clients?focus=${updated.convertedToClientId}`);
      } else {
        router.push('/clients');
      }
    } catch {
      // Toast handled in the mutation's onError; swallow here so the dialog stays open.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Convert lead to client</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Promote {lead.name} into a client record. Pick one of the options below.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList>
            <TabsTrigger value="new">Create new client</TabsTrigger>
            <TabsTrigger value="existing">Link to existing</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'new' ? (
          <div className="space-y-3">
            <Field label="Client name" htmlFor="convert-name" required>
              <Input
                id="convert-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Email" htmlFor="convert-email">
                <Input
                  id="convert-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Phone" htmlFor="convert-phone">
                <Input
                  id="convert-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Website" htmlFor="convert-website">
              <Input
                id="convert-website"
                type="url"
                placeholder="https://"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </Field>
            <Field label="Notes" htmlFor="convert-notes">
              <Textarea
                id="convert-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Existing client">
              <ClientCombobox
                value={existingClientId}
                onChange={setExistingClientId}
                clearable={false}
                placeholder="Pick a client"
              />
            </Field>
            <p className="text-xs text-ink-muted">
              The lead will be marked as Won and linked to the chosen client.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? 'Converting…' : mode === 'new' ? 'Create client & convert' : 'Link & convert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-1 text-state-error" aria-hidden>*</span> : null}
      </Label>
      {children}
    </div>
  );
}
