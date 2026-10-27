'use client';

import { ExternalLink, Repeat2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { LeadWithOwner, UpdateLeadInput } from '@botss/shared-types';

import { ConvertLeadDialog } from '@/components/leads/convert-lead-dialog';
import {
  SOURCE_OPTIONS,
  STAGE_OPTIONS,
  sourceLabel,
  stageLabel,
} from '@/components/leads/lead-badges';
import { CURRENCY_OPTIONS } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmByTypingDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TagInput } from '@/components/ui/tag-input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import { useDeleteLead, useUpdateLead } from '@/hooks/use-leads';
import { useIsMobile } from '@/hooks/use-media-query';
import { useCreateTodo } from '@/hooks/use-todos';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast, toastErrorMessage } from '@/lib/toast';

interface Props {
  lead: LeadWithOwner | null;
  onClose: () => void;
}

export function LeadDetailPanel({ lead, onClose }: Props) {
  const open = lead !== null;
  const isMobile = useIsMobile();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side={isMobile ? 'bottom' : 'right'} aria-describedby={undefined}>
        {lead ? <PanelInner lead={lead} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelInner({ lead, onClose }: { lead: LeadWithOwner; onClose: () => void }) {
  const update = useUpdateLead();
  const remove = useDeleteLead();
  const createTodo = useCreateTodo();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  // Local state for free-text fields so we can debounce/blur-save without
  // re-rendering on every keystroke. Refs track the last upstream-synced value
  // so we don't stomp on user edits mid-typing if the cache updates elsewhere.
  const [name, setName] = useState(lead.name);
  const [email, setEmail] = useState(lead.email ?? '');
  const [phone, setPhone] = useState(lead.phone ?? '');
  const [company, setCompany] = useState(lead.company ?? '');
  const [jobTitle, setJobTitle] = useState(lead.jobTitle ?? '');
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [estimatedValue, setEstimatedValue] = useState(lead.estimatedValue ?? '');
  // Follow-up: a local "YYYY-MM-DDTHH:mm" value for the datetime-local input,
  // plus an opt-in to spin off a personal to-do at that time.
  const [followupInput, setFollowupInput] = useState(toLocalInputValue(lead.followupAt));
  const [scheduleTodo, setScheduleTodo] = useState(true);

  const nameRef = useRef(lead.name);
  const emailRef = useRef(lead.email ?? '');
  const phoneRef = useRef(lead.phone ?? '');
  const companyRef = useRef(lead.company ?? '');
  const jobTitleRef = useRef(lead.jobTitle ?? '');
  const notesRef = useRef(lead.notes ?? '');
  const estimateRef = useRef(lead.estimatedValue ?? '');
  const followupRef = useRef(lead.followupAt ? lead.followupAt.getTime() : 0);

  useEffect(() => {
    if (lead.name !== nameRef.current) {
      nameRef.current = lead.name;
      setName(lead.name);
    }
    const e = lead.email ?? '';
    if (e !== emailRef.current) {
      emailRef.current = e;
      setEmail(e);
    }
    const p = lead.phone ?? '';
    if (p !== phoneRef.current) {
      phoneRef.current = p;
      setPhone(p);
    }
    const c = lead.company ?? '';
    if (c !== companyRef.current) {
      companyRef.current = c;
      setCompany(c);
    }
    const j = lead.jobTitle ?? '';
    if (j !== jobTitleRef.current) {
      jobTitleRef.current = j;
      setJobTitle(j);
    }
    const n = lead.notes ?? '';
    if (n !== notesRef.current) {
      notesRef.current = n;
      setNotes(n);
    }
    const ev = lead.estimatedValue ?? '';
    if (ev !== estimateRef.current) {
      estimateRef.current = ev;
      setEstimatedValue(ev);
    }
    const fu = lead.followupAt ? lead.followupAt.getTime() : 0;
    if (fu !== followupRef.current) {
      followupRef.current = fu;
      setFollowupInput(toLocalInputValue(lead.followupAt));
    }
  }, [
    lead.id,
    lead.name,
    lead.email,
    lead.phone,
    lead.company,
    lead.jobTitle,
    lead.notes,
    lead.estimatedValue,
    lead.followupAt,
  ]);

  const save = (input: UpdateLeadInput) => {
    update.mutate({ id: lead.id, input });
  };

  const debouncedSaveNotes = useDebouncedCallback((value: string) => {
    if (value === (lead.notes ?? '')) return;
    save({ notes: value });
  }, 1000);

  const trimmedOrNull = (raw: string): string | null => {
    const t = raw.trim();
    return t.length === 0 ? null : t;
  };

  // Commit the follow-up on blur/change. Only acts when the value actually
  // changed so re-blurring never re-saves or spawns a duplicate to-do.
  const commitFollowup = (raw: string) => {
    const current = toLocalInputValue(lead.followupAt);
    if (raw === current) return;
    if (raw === '') {
      save({ followupAt: null });
      return;
    }
    // datetime-local has no timezone, so `new Date(raw)` is parsed as local.
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return;
    if (date.getTime() < Date.now()) {
      toastErrorMessage('The follow up must be set for now or a future time');
      setFollowupInput(current);
      return;
    }
    save({ followupAt: date });
    if (scheduleTodo) {
      createTodo.mutate(
        {
          title: `Follow up with ${lead.name}`,
          notes: 'Auto-created from the lead follow-up.',
          dueDate: date,
          workspaceId: lead.workspaceId,
        },
        { onSuccess: () => toast.success('Follow up scheduled.') },
      );
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-xs uppercase tracking-wide text-ink-muted">Lead</SheetTitle>
        <Input
          aria-label="Lead name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (trimmed.length === 0) {
              setName(lead.name);
              toastErrorMessage('Name cannot be empty');
              return;
            }
            if (trimmed === lead.name) return;
            save({ name: trimmed });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="text-lg font-semibold border-transparent shadow-none px-2 -mx-2 hover:bg-bg-subtle focus:bg-white focus:border-brand-purple"
        />
        {lead.company ? (
          <p className="text-sm text-ink-muted">{lead.company}</p>
        ) : null}
      </SheetHeader>
      <SheetBody>
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Email" htmlFor="lead-email">
              <Input
                id="lead-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => {
                  if (email === (lead.email ?? '')) return;
                  save({ email: email.trim() === '' ? null : email.trim() });
                }}
              />
            </Field>
            <Field label="Phone" htmlFor="lead-phone">
              <Input
                id="lead-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={() => {
                  if (phone === (lead.phone ?? '')) return;
                  save({ phone: trimmedOrNull(phone) });
                }}
              />
            </Field>
            <Field label="Company" htmlFor="lead-company">
              <Input
                id="lead-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onBlur={() => {
                  if (company === (lead.company ?? '')) return;
                  save({ company: trimmedOrNull(company) });
                }}
              />
            </Field>
            <Field label="Job title" htmlFor="lead-jobtitle">
              <Input
                id="lead-jobtitle"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                onBlur={() => {
                  if (jobTitle === (lead.jobTitle ?? '')) return;
                  save({ jobTitle: trimmedOrNull(jobTitle) });
                }}
              />
            </Field>

            <Field label="Stage" htmlFor="lead-stage">
              <Select
                value={lead.stage}
                onValueChange={(v) => save({ stage: v as UpdateLeadInput['stage'] })}
              >
                <SelectTrigger id="lead-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {stageLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Source" htmlFor="lead-source">
              <Select
                value={lead.source}
                onValueChange={(v) => save({ source: v as UpdateLeadInput['source'] })}
              >
                <SelectTrigger id="lead-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {sourceLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Estimated value" htmlFor="lead-value">
              <Input
                id="lead-value"
                inputMode="decimal"
                value={estimatedValue}
                onChange={(e) => setEstimatedValue(e.target.value)}
                onBlur={() => {
                  const raw = estimatedValue.trim();
                  const current = lead.estimatedValue ?? '';
                  if (raw === current) return;
                  if (raw === '') {
                    save({ estimatedValue: null });
                    return;
                  }
                  const num = Number(raw);
                  if (!Number.isFinite(num) || num < 0) {
                    toastErrorMessage('Estimated value must be a positive number');
                    setEstimatedValue(current);
                    return;
                  }
                  save({ estimatedValue: String(num) });
                }}
                placeholder="0"
              />
            </Field>
            <Field label="Currency" htmlFor="lead-currency">
              <Select
                value={lead.currency}
                onValueChange={(v) => save({ currency: v })}
              >
                <SelectTrigger id="lead-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* Owner is whoever captured the lead - historical, so read-only.
                Assignee is the live field and decides who can see the lead. */}
            <Field label="Owner" htmlFor="lead-owner">
              <p
                id="lead-owner"
                className="flex h-9 items-center text-sm text-ink"
              >
                {lead.owner?.name || lead.owner?.email || (
                  <span className="text-ink-muted">Unknown</span>
                )}
              </p>
            </Field>

            <Field label="Assignee" htmlFor="lead-assignee">
              <WorkspaceMembersCombobox
                value={lead.assigneeId}
                onChange={(userId) => save({ assigneeId: userId })}
              />
            </Field>
          </div>

          <Field label="Follow-up" htmlFor="lead-followup">
            <Input
              id="lead-followup"
              type="datetime-local"
              value={followupInput}
              min={toLocalInputValue(new Date())}
              onChange={(e) => setFollowupInput(e.target.value)}
              onBlur={() => commitFollowup(followupInput)}
            />
            <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-xs text-ink-muted">
              <Checkbox
                checked={scheduleTodo}
                onCheckedChange={(v) => setScheduleTodo(v === true)}
              />
              Also add a to-do reminder for this date and time
            </label>
          </Field>

          <Field label="Tags" htmlFor="lead-tags">
            <TagInput
              id="lead-tags"
              aria-label="Tags"
              value={lead.tags}
              onChange={(next) => save({ tags: next })}
              placeholder="Type a tag and press Enter"
            />
          </Field>

          <Field label="Notes" htmlFor="lead-notes">
            <Textarea
              id="lead-notes"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                debouncedSaveNotes(e.target.value);
              }}
              rows={5}
              placeholder="Capture context, conversations, next steps…"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-line pt-4">
            <ReadOnly label="Created">
              <Tooltip content={absoluteTime(lead.createdAt)}>
                <span className="text-sm text-ink">{relativeTime(lead.createdAt)}</span>
              </Tooltip>
            </ReadOnly>
            <ReadOnly label="Updated">
              <Tooltip content={absoluteTime(lead.updatedAt)}>
                <span className="text-sm text-ink">{relativeTime(lead.updatedAt)}</span>
              </Tooltip>
            </ReadOnly>
            {lead.convertedAt ? (
              <ReadOnly label="Converted">
                <Tooltip content={absoluteTime(lead.convertedAt)}>
                  <span className="text-sm text-ink">{relativeTime(lead.convertedAt)}</span>
                </Tooltip>
              </ReadOnly>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            {lead.convertedToClientId ? (
              <Link
                href={`/clients?focus=${lead.convertedToClientId}`}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800 sm:order-1
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus rounded"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                View client
              </Link>
            ) : lead.stage === 'WON' ? (
              <Button onClick={() => setConvertOpen(true)} className="sm:order-1">
                <Repeat2 className="h-4 w-4" />
                Convert to client
              </Button>
            ) : (
              <span className="text-xs text-ink-muted sm:order-1">Move to Won to convert.</span>
            )}
            <Button
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              className="sm:order-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete lead
            </Button>
          </div>
        </div>
      </SheetBody>

      <ConfirmByTypingDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this lead?"
        description="This action cannot be undone. The lead's notes and history will be removed."
        challenge={lead.name}
        challengeLabel="Type the lead's name"
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync(lead.id);
          setConfirmOpen(false);
          onClose();
          toast.success('Lead deleted.');
        }}
      />

      <ConvertLeadDialog
        lead={lead}
        open={convertOpen}
        onOpenChange={setConvertOpen}
        onConverted={() => {
          setConvertOpen(false);
          onClose();
        }}
      />
    </>
  );
}

/**
 * Format a Date into the local "YYYY-MM-DDTHH:mm" string a datetime-local
 * input expects. Subtracts the timezone offset so the wall-clock time the user
 * sees matches the stored instant. Returns '' for null.
 */
function toLocalInputValue(d: Date | null): string {
  if (!d) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
