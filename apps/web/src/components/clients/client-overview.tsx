'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ClientDetail, UpdateClientInput } from '@botss/shared-types';

import {
  CLIENT_STATUS_OPTIONS,
  ClientStatusBadge,
  statusLabel,
} from '@/components/clients/client-badges';
import { ClientCustomFields } from '@/components/clients/client-custom-fields';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TagInput } from '@/components/ui/tag-input';
import { Tooltip } from '@/components/ui/tooltip';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import { useUpdateClient } from '@/hooks/use-clients';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toastErrorMessage } from '@/lib/toast';

interface Props {
  client: ClientDetail;
}

export function ClientOverview({ client }: Props) {
  const update = useUpdateClient();
  const save = (input: UpdateClientInput) => update.mutate({ id: client.id, input });

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="client-identity-heading"
        className="rounded-lg border border-line bg-white p-5"
      >
        <h2 id="client-identity-heading" className="text-base font-semibold text-ink">
          Identity
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Changes save automatically.</p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <EditableField
            label="Name"
            id="client-name"
            value={client.name}
            allowEmpty={false}
            onSave={(v) => save({ name: v })}
            emptyError="Name cannot be empty."
          />
          <EditableField
            label="Legal name"
            id="client-legal-name"
            value={client.legalName ?? ''}
            placeholder="e.g. Acme Inc."
            onSave={(v) => save({ legalName: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Email"
            id="client-email"
            type="email"
            value={client.email ?? ''}
            onSave={(v) => save({ email: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Phone"
            id="client-phone"
            type="tel"
            value={client.phone ?? ''}
            onSave={(v) => save({ phone: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Website"
            id="client-website"
            type="url"
            value={client.website ?? ''}
            placeholder="https://"
            onSave={(v) => save({ website: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Industry"
            id="client-industry"
            value={client.industry ?? ''}
            onSave={(v) => save({ industry: v.length === 0 ? undefined : v })}
            nullable
          />

          <div className="space-y-1.5">
            <Label htmlFor="client-status">Status</Label>
            <div className="flex items-center gap-2">
              <Select
                value={client.status}
                onValueChange={(v) => save({ status: v as ClientDetail['status'] })}
              >
                <SelectTrigger id="client-status" className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ClientStatusBadge status={client.status} />
            </div>
          </div>

          {/* Owner is whoever created the client - historical, so read-only.
              Assignee is the live field and decides who can see the client. */}
          <div className="space-y-1.5">
            <Label htmlFor="client-owner">Owner</Label>
            <p id="client-owner" className="flex h-9 items-center text-sm text-ink">
              {client.owner?.name || client.owner?.email || (
                <span className="text-ink-muted">Unknown</span>
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="client-assignee">Assignee</Label>
            <WorkspaceMembersCombobox
              value={client.assigneeId}
              onChange={(userId) => save({ assigneeId: userId })}
            />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="client-address-heading"
        className="rounded-lg border border-line bg-white p-5"
      >
        <h2 id="client-address-heading" className="text-base font-semibold text-ink">
          Address
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <EditableField
            label="Address line 1"
            id="client-address1"
            value={client.addressLine1 ?? ''}
            onSave={(v) => save({ addressLine1: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Address line 2"
            id="client-address2"
            value={client.addressLine2 ?? ''}
            onSave={(v) => save({ addressLine2: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="City"
            id="client-city"
            value={client.city ?? ''}
            onSave={(v) => save({ city: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="State / region"
            id="client-state"
            value={client.state ?? ''}
            onSave={(v) => save({ state: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Postal code"
            id="client-postal"
            value={client.postalCode ?? ''}
            onSave={(v) => save({ postalCode: v.length === 0 ? undefined : v })}
            nullable
          />
          <EditableField
            label="Country"
            id="client-country"
            value={client.country ?? ''}
            onSave={(v) => save({ country: v.length === 0 ? undefined : v })}
            nullable
          />
        </div>
      </section>

      <section
        aria-labelledby="client-meta-heading"
        className="rounded-lg border border-line bg-white p-5"
      >
        <h2 id="client-meta-heading" className="text-base font-semibold text-ink">
          Tags & references
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <EditableField
            label="Tax ID"
            id="client-tax-id"
            value={client.taxId ?? ''}
            onSave={(v) => save({ taxId: v.length === 0 ? undefined : v })}
            nullable
          />
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="client-tags">Tags</Label>
            <TagInput
              id="client-tags"
              value={client.tags}
              onChange={(next) => save({ tags: next })}
              placeholder="Add a tag and press Enter"
            />
          </div>
        </div>
      </section>

      <ClientCustomFields clientId={client.id} />

      <section
        aria-labelledby="client-meta-readonly"
        className="rounded-lg border border-line bg-white p-5"
      >
        <h2 id="client-meta-readonly" className="text-base font-semibold text-ink">
          Metadata
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <ReadOnly label="Created">
            <Tooltip content={absoluteTime(client.createdAt)}>
              <span>{relativeTime(client.createdAt)}</span>
            </Tooltip>
          </ReadOnly>
          <ReadOnly label="Updated">
            <Tooltip content={absoluteTime(client.updatedAt)}>
              <span>{relativeTime(client.updatedAt)}</span>
            </Tooltip>
          </ReadOnly>
          <ReadOnly label="Created by">
            <span>{client.owner?.name || client.owner?.email || 'Unknown'}</span>
          </ReadOnly>
          {client.convertedFromLead ? (
            <ReadOnly label="Converted from lead">
              <Link
                href={`/leads?focus=${client.convertedFromLead.id}`}
                className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus rounded"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                {client.convertedFromLead.name}
              </Link>
            </ReadOnly>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

interface EditableFieldProps {
  label: string;
  id: string;
  value: string;
  type?: 'text' | 'email' | 'tel' | 'url';
  placeholder?: string;
  allowEmpty?: boolean;
  emptyError?: string;
  nullable?: boolean;
  onSave: (next: string) => void;
}

/**
 * Self-contained text field that saves on blur (or Enter). Keeps local state
 * so a parent re-render from cache patches doesn't stomp on what the user is
 * still typing - the `ref` mirror tracks the upstream value the user has
 * already seen.
 */
function EditableField({
  label,
  id,
  value,
  type = 'text',
  placeholder,
  allowEmpty = true,
  emptyError,
  onSave,
}: EditableFieldProps) {
  const [local, setLocal] = useState(value);
  const upstreamRef = useRef(value);

  useEffect(() => {
    if (value !== upstreamRef.current) {
      upstreamRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const commit = () => {
    const next = local.trim();
    if (next === value.trim()) return;
    if (!allowEmpty && next.length === 0) {
      setLocal(value);
      if (emptyError) toastErrorMessage(emptyError);
      return;
    }
    onSave(next);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}
