'use client';

import { ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { InvoiceSettings } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader, PageLoader } from '@/components/ui/loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useFileUpload } from '@/hooks/use-file-upload';
import {
  useInvoiceSettings,
  useInvoiceTemplates,
  useUpdateInvoiceSettings,
} from '@/hooks/use-invoices';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';
import { CURRENCY_OPTIONS } from '@/lib/money';
import { toastError, toastErrorMessage } from '@/lib/toast';

const NONE = '__none__';
const LOGO_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';

type TextKey =
  | 'companyName'
  | 'address'
  | 'email'
  | 'phone'
  | 'website'
  | 'taxId'
  | 'bankDetails'
  | 'paymentTerms'
  | 'footer';

/**
 * Organization-wide invoice branding. Every invoice template reads these as
 * `company.*`, so a change here shows up on the next preview and PDF.
 */
export default function InvoicingSettingsPage() {
  const { checking, allowed } = useRequireSystemRole(['ADMIN', 'SUPER_ADMIN', 'FINANCE']);
  const settings = useInvoiceSettings();
  const templates = useInvoiceTemplates();
  const save = useUpdateInvoiceSettings();
  const upload = useFileUpload();
  const fileInput = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<InvoiceSettings>({});
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const { logoUrl: url, ...rest } = settings.data;
    setForm(rest);
    setLogoUrl(url ?? null);
  }, [settings.data]);

  if (checking || !allowed) return <PageLoader label="Loading" />;

  const setText = (key: TextKey) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value.trim() === '' ? null : value }));

  async function onPickLogo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toastErrorMessage('Logos must be 2 MB or smaller');
      return;
    }
    try {
      const uploaded = await upload.mutateAsync(file);
      setForm((prev) => ({ ...prev, logoFileId: uploaded.id }));
      setLogoUrl(uploaded.url ?? null);
    } catch (err) {
      toastError(err, "Couldn't upload the logo");
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function submit() {
    setError(null);
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Billing email does not look like an email address.');
      return;
    }
    if (form.accentColor && !/^#[0-9a-fA-F]{6}$/.test(form.accentColor)) {
      setError('Accent color must be a hex color such as #7b6fe8.');
      return;
    }
    save.mutate(form);
  }

  const templateItems = templates.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-ink text-lg font-semibold">Invoicing</h2>
        <p className="text-ink-muted mt-1 text-sm">
          Company details every invoice template prints, the default template, and invoice defaults.
          Templates themselves are HTML files in the app, see{' '}
          <code className="bg-bg-subtle rounded px-1 text-xs">apps/api/invoice-templates</code>.
        </p>
      </header>

      {settings.isLoading ? (
        <PageLoader label="Loading invoice settings" className="min-h-[12rem]" />
      ) : settings.isError ? (
        <div className="border-line bg-bg-surface text-ink-muted rounded-md border p-6 text-sm">
          Couldn&apos;t load invoice settings.{' '}
          <button type="button" className="underline" onClick={() => void settings.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          noValidate
        >
          <section className="border-line bg-bg-surface space-y-4 rounded-lg border p-4">
            <h3 className="text-ink text-sm font-semibold">Company</h3>
            <div className="flex flex-wrap items-center gap-4">
              <div className="border-line bg-bg-subtle grid h-16 w-40 place-items-center overflow-hidden rounded-md border border-dashed">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt="Company logo"
                    className="max-h-14 max-w-36 object-contain"
                  />
                ) : (
                  <span className="text-ink-disabled text-xs">No logo</span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept={LOGO_TYPES}
                  className="hidden"
                  onChange={(e) => void onPickLogo(e.target.files)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? (
                    <Loader size="xs" label="Uploading" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  {logoUrl ? 'Replace logo' : 'Upload logo'}
                </Button>
                {form.logoFileId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setForm((prev) => ({ ...prev, logoFileId: null }));
                      setLogoUrl(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Company name"
                value={form.companyName}
                onChange={setText('companyName')}
              />
              <TextField
                label="Billing email"
                value={form.email}
                onChange={setText('email')}
                hint="Replies to invoices sent from the no-reply address go here."
              />
              <TextField label="Phone" value={form.phone} onChange={setText('phone')} />
              <TextField label="Website" value={form.website} onChange={setText('website')} />
              <TextField label="Tax ID" value={form.taxId} onChange={setText('taxId')} />
              <div>
                <Label htmlFor="accent">Accent color</Label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id="accent-picker"
                    type="color"
                    aria-label="Pick accent color"
                    value={form.accentColor ?? '#7b6fe8'}
                    onChange={(e) => setForm((prev) => ({ ...prev, accentColor: e.target.value }))}
                    className="border-line bg-bg-surface h-10 w-12 cursor-pointer rounded-md border"
                  />
                  <Input
                    id="accent"
                    value={form.accentColor ?? ''}
                    placeholder="#7b6fe8"
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, accentColor: e.target.value.trim() || null }))
                    }
                  />
                </div>
              </div>
            </div>
            <AreaField
              label="Address"
              value={form.address}
              onChange={setText('address')}
              rows={3}
            />
          </section>

          <section className="border-line bg-bg-surface space-y-4 rounded-lg border p-4">
            <h3 className="text-ink text-sm font-semibold">Payment</h3>
            <AreaField
              label="Bank details"
              value={form.bankDetails}
              onChange={setText('bankDetails')}
              rows={4}
              hint="Account title, bank, IBAN, SWIFT. Printed on every invoice."
            />
            <AreaField
              label="Payment terms"
              value={form.paymentTerms}
              onChange={setText('paymentTerms')}
              rows={2}
              hint="Used when an invoice has no terms of its own."
            />
            <TextField
              label="Footer"
              value={form.footer}
              onChange={setText('footer')}
              hint="Used when an invoice has no footer of its own."
            />
          </section>

          <section className="border-line bg-bg-surface space-y-4 rounded-lg border p-4">
            <h3 className="text-ink text-sm font-semibold">Defaults</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label>Default template</Label>
                <Select
                  value={form.defaultTemplateKey ?? NONE}
                  onValueChange={(v) =>
                    setForm((prev) => ({ ...prev, defaultTemplateKey: v === NONE ? null : v }))
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Built-in default</SelectItem>
                    {templateItems.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Default currency</Label>
                <Select
                  value={form.defaultCurrency ?? NONE}
                  onValueChange={(v) =>
                    setForm((prev) => ({ ...prev, defaultCurrency: v === NONE ? null : v }))
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>USD</SelectItem>
                    {CURRENCY_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="due-days">Due after (days)</Label>
                <Input
                  id="due-days"
                  className="mt-1"
                  inputMode="numeric"
                  value={form.defaultDueDays ?? ''}
                  placeholder="14"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value.replace(/\D/g, ''), 10);
                    setForm((prev) => ({
                      ...prev,
                      defaultDueDays: Number.isFinite(n) ? Math.min(365, n) : null,
                    }));
                  }}
                />
              </div>
            </div>
          </section>

          {error ? <p className="text-state-error text-sm">{error}</p> : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending || upload.isPending}>
              {save.isPending ? 'Saving' : 'Save invoice settings'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = `inv-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="mt-1"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-ink-muted mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}

function AreaField({
  label,
  value,
  onChange,
  rows,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  rows: number;
  hint?: string;
}) {
  const id = `inv-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="mt-1"
        rows={rows}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-ink-muted mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}
