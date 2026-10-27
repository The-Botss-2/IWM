'use client';

import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PaymentSourceKind } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreatePaymentSource, usePaymentSources } from '@/hooks/use-finance';

export const SOURCE_KIND_LABEL: Record<PaymentSourceKind, string> = {
  FREELANCE_PLATFORM: 'Freelance platform',
  BANK: 'Bank',
  REMITTANCE: 'Remittance',
  WALLET: 'Wallet',
  GATEWAY: 'Payment gateway',
  CASH: 'Cash',
  OTHER: 'Other',
};

export const SOURCE_KIND_OPTIONS = Object.keys(
  SOURCE_KIND_LABEL,
) as PaymentSourceKind[];

/**
 * Payment-source picker with an inline "add a new one" escape hatch.
 *
 * The finance manager hits a new rail mid-entry more often than they visit a
 * settings page, so creating one has to be possible without losing the payment
 * they were half way through recording.
 */
export function PaymentSourceCombobox({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** Lets a <Label htmlFor> name the picker. */
  id?: string;
}) {
  const sources = usePaymentSources();
  const create = useCreatePaymentSource();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PaymentSourceKind>('OTHER');

  const options = useMemo(
    () =>
      (sources.data?.items ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        description: SOURCE_KIND_LABEL[s.kind],
      })),
    [sources.data],
  );

  async function submit() {
    if (!name.trim()) return;
    try {
      const created = await create.mutateAsync({ name: name.trim(), kind });
      // Select the new rail immediately - the user created it to use it.
      onChange(created.id);
      setAdding(false);
      setName('');
      setKind('OTHER');
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Combobox
          id={id}
          className="flex-1"
          options={options}
          value={value}
          onChange={onChange}
          placeholder={
            sources.isLoading ? 'Loading…' : sources.isError ? "Couldn't load" : 'Select a source…'
          }
          clearable
        />
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Add payment source"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New payment source</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="src-name">Name</Label>
              <Input
                id="src-name"
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skrill"
                autoFocus
              />
            </div>
            <div>
              <Label>Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as PaymentSourceKind)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_KIND_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {SOURCE_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
