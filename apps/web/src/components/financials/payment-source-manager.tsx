'use client';

import { arrayMove } from '@dnd-kit/sortable';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useState } from 'react';
import type { PaymentRegion, PaymentSourceKind } from '@botss/shared-types';

import {
  SOURCE_KIND_LABEL,
  SOURCE_KIND_OPTIONS,
} from '@/components/financials/payment-source-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { QueryError } from '@/components/ui/query-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreatePaymentSource,
  useDeletePaymentSource,
  usePaymentSources,
  useReorderPaymentSources,
  useUpdatePaymentSource,
} from '@/hooks/use-finance';
import { useAbility } from '@/lib/ability';

const REGION_LABEL: Record<PaymentRegion | '__any__', string> = {
  LOCAL: 'Local',
  INTERNATIONAL: 'International',
  __any__: 'Ask each time',
};

/**
 * The rails money moves through, editable by the finance manager without a
 * developer. Inactive rows stay visible here (but not in the payment picker)
 * because historical payments still point at them.
 */
export function PaymentSourceManager() {
  const [showInactive, setShowInactive] = useState(true);
  const sources = usePaymentSources(showInactive);
  const update = useUpdatePaymentSource();
  const del = useDeletePaymentSource();
  const reorder = useReorderPaymentSources();
  // UX hint; the API checks `update PaymentSource` on the reorder.
  const canReorder = useAbility().can('update', 'PaymentSource');
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; name: string; used: boolean } | null>(
    null,
  );

  if (sources.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (sources.isError && !sources.data) {
    return (
      <QueryError message="Couldn't load payment sources." onRetry={() => void sources.refetch()} />
    );
  }

  const items = sources.data?.items ?? [];
  // Reorder only from the full list: positions are org-wide, and moving
  // within the active-only view would leave hidden rows where they were.
  const reorderable = canReorder && showInactive && items.length > 1;
  const move = (index: number, by: -1 | 1) =>
    reorder.mutate({
      ids: arrayMove(
        items.map((s) => s.id),
        index,
        index + by,
      ),
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ink-muted text-sm">
          Where money arrives from and goes out through. Shared across every workspace in the
          organisation.
          {canReorder && !showInactive ? ' Show inactive sources to change the order.' : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? 'Hide inactive' : 'Show inactive'}
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add source
          </Button>
        </div>
      </div>

      <ul className="divide-line border-line bg-bg-surface divide-y rounded-md border" role="list">
        {items.map((s, index) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            {reorderable ? (
              <span className="flex items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${s.name} up`}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${s.name} down`}
                  disabled={index === items.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </span>
            ) : null}
            <span className={`font-medium ${s.isActive ? '' : 'text-ink-muted line-through'}`}>
              {s.name}
            </span>
            <Badge tone="neutral">{SOURCE_KIND_LABEL[s.kind]}</Badge>
            <Badge tone={s.defaultRegion === 'INTERNATIONAL' ? 'info' : 'outline'}>
              {REGION_LABEL[s.defaultRegion ?? '__any__']}
            </Badge>
            {s.defaultFeePercent ? (
              <span className="text-ink-muted text-xs">
                {Number(s.defaultFeePercent)}% typical fee
              </span>
            ) : null}
            <span className="text-ink-muted ml-auto text-xs">
              {s.usageCount > 0 ? `${s.usageCount} used` : 'unused'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => update.mutate({ id: s.id, input: { isActive: !s.isActive } })}
            >
              {s.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming({ id: s.id, name: s.name, used: s.usageCount > 0 })}
            >
              Remove
            </Button>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-ink-muted px-3 py-8 text-center text-sm">No payment sources yet.</li>
        ) : null}
      </ul>

      <SourceDialog open={adding} onOpenChange={setAdding} />

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming?.used ? 'Deactivate this source?' : 'Remove this source?'}
        description={
          confirming?.used
            ? `${confirming.name} is referenced by existing records, so it will be deactivated rather than deleted. Those records keep their provenance.`
            : `${confirming?.name ?? ''} will be removed permanently.`
        }
        confirmLabel={confirming?.used ? 'Deactivate' : 'Remove'}
        variant="destructive"
        pending={del.isPending}
        onConfirm={async () => {
          if (!confirming) return;
          try {
            await del.mutateAsync(confirming.id);
            setConfirming(null);
          } catch {
            // Toast raised by the hook; keep the dialog open.
          }
        }}
      />
    </div>
  );
}

function SourceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreatePaymentSource();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PaymentSourceKind>('OTHER');
  const [region, setRegion] = useState<PaymentRegion | '__any__'>('__any__');
  const [fee, setFee] = useState('');

  async function submit() {
    try {
      await create.mutateAsync({
        name: name.trim(),
        kind,
        defaultRegion: region === '__any__' ? null : region,
        ...(fee.trim() ? { defaultFeePercent: fee.trim() } : {}),
      });
      setName('');
      setKind('OTHER');
      setRegion('__any__');
      setFee('');
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New payment source</DialogTitle>
          <DialogDescription>
            A rail money moves through. Defaults here just prefill the payment form; every field
            stays editable per payment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="ps-name">Name</Label>
            <Input
              id="ps-name"
              className="mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Skrill"
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as PaymentSourceKind)}>
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
            <div>
              <Label>Default region</Label>
              <Select
                value={region}
                onValueChange={(v) => setRegion(v as PaymentRegion | '__any__')}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Ask each time</SelectItem>
                  <SelectItem value="LOCAL">Local</SelectItem>
                  <SelectItem value="INTERNATIONAL">International</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="ps-fee">Typical fee %</Label>
            <Input
              id="ps-fee"
              className="mt-1"
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="10"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Adding…' : 'Add source'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
