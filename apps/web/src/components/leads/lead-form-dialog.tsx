'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import {
  createLeadSchema,
  type CreateLeadInput,
  type LeadSource,
  type LeadStage,
} from '@botss/shared-types';

import {
  SOURCE_OPTIONS,
  STAGE_OPTIONS,
  sourceLabel,
  stageLabel,
} from '@/components/leads/lead-badges';
import { CURRENCY_OPTIONS } from '@/lib/money';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import { useCreateLead } from '@/hooks/use-leads';
import { toast, toastErrorMessage } from '@/lib/toast';

const DEFAULT_VALUES: CreateLeadInput = {
  name: '',
  email: undefined,
  phone: undefined,
  company: undefined,
  jobTitle: undefined,
  stage: 'NEW',
  source: 'OTHER',
  estimatedValue: undefined,
  currency: 'USD',
  notes: undefined,
  tags: [],
  assigneeId: undefined,
};

export function LeadFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateLead();
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const onSubmit = handleSubmit(async (data) => {
    // The schema accepts empty strings on optional fields after Zod's
    // `z.coerce.string().optional()` coercion. Strip them so the API doesn't
    // receive `''` (which Prisma rejects for nullable Decimal/email columns).
    const value = data.estimatedValue?.toString().trim();
    let estimatedValue: string | undefined;
    if (value && value.length > 0) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        toastErrorMessage('Estimated value must be a positive number');
        return;
      }
      estimatedValue = String(n);
    }

    const cleaned: CreateLeadInput = {
      name: data.name.trim(),
      stage: data.stage,
      source: data.source,
      currency: data.currency,
      tags: data.tags ?? [],
      ...(data.email && data.email.length > 0 ? { email: data.email.trim() } : {}),
      ...(data.phone && data.phone.length > 0 ? { phone: data.phone.trim() } : {}),
      ...(data.company && data.company.length > 0 ? { company: data.company.trim() } : {}),
      ...(data.jobTitle && data.jobTitle.length > 0 ? { jobTitle: data.jobTitle.trim() } : {}),
      ...(data.notes && data.notes.length > 0 ? { notes: data.notes.trim() } : {}),
      ...(estimatedValue !== undefined ? { estimatedValue } : {}),
      ...(data.assigneeId ? { assigneeId: data.assigneeId } : {}),
    };

    try {
      await create.mutateAsync(cleaned);
      toast.success('Lead created.');
      reset(DEFAULT_VALUES);
      onOpenChange(false);
    } catch {
      // Toast handled in the mutation's onError; keep the dialog open.
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset(DEFAULT_VALUES);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">New lead</DialogTitle>
          <DialogDescription className="text-ink-muted text-sm">
            Capture a new opportunity. You can refine details after creating.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <Field label="Name" htmlFor="new-lead-name" required error={errors.name?.message}>
            <Input
              id="new-lead-name"
              autoFocus
              autoComplete="off"
              aria-invalid={!!errors.name}
              {...register('name')}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Email" htmlFor="new-lead-email" error={errors.email?.message}>
              <Input
                id="new-lead-email"
                type="email"
                autoComplete="off"
                aria-invalid={!!errors.email}
                {...register('email')}
              />
            </Field>
            <Field label="Phone" htmlFor="new-lead-phone" error={errors.phone?.message}>
              <Input id="new-lead-phone" type="tel" autoComplete="off" {...register('phone')} />
            </Field>
            <Field label="Company" htmlFor="new-lead-company" error={errors.company?.message}>
              <Input id="new-lead-company" autoComplete="off" {...register('company')} />
            </Field>
            <Field label="Job title" htmlFor="new-lead-jobtitle" error={errors.jobTitle?.message}>
              <Input id="new-lead-jobtitle" autoComplete="off" {...register('jobTitle')} />
            </Field>

            <Field label="Stage" htmlFor="new-lead-stage">
              <Controller
                control={control}
                name="stage"
                render={({ field }) => (
                  <Select
                    value={field.value ?? 'NEW'}
                    onValueChange={(v) => field.onChange(v as LeadStage)}
                  >
                    <SelectTrigger id="new-lead-stage">
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
                )}
              />
            </Field>
            <Field label="Source" htmlFor="new-lead-source">
              <Controller
                control={control}
                name="source"
                render={({ field }) => (
                  <Select
                    value={field.value ?? 'OTHER'}
                    onValueChange={(v) => field.onChange(v as LeadSource)}
                  >
                    <SelectTrigger id="new-lead-source">
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
                )}
              />
            </Field>

            <Field
              label="Estimated value"
              htmlFor="new-lead-value"
              error={errors.estimatedValue?.message}
            >
              <Input
                id="new-lead-value"
                inputMode="decimal"
                placeholder="0"
                {...register('estimatedValue')}
              />
            </Field>
            <Field label="Currency" htmlFor="new-lead-currency">
              <Controller
                control={control}
                name="currency"
                render={({ field }) => (
                  <Select value={field.value ?? 'USD'} onValueChange={field.onChange}>
                    <SelectTrigger id="new-lead-currency">
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
                )}
              />
            </Field>

            {/* No Owner picker here - the owner is always the creator, set
                server-side from the session. Only the assignee is a choice. */}
            <Field label="Assignee" htmlFor="new-lead-assignee">
              <Controller
                control={control}
                name="assigneeId"
                render={({ field }) => (
                  <WorkspaceMembersCombobox
                    value={field.value ?? null}
                    onChange={(id) => field.onChange(id ?? undefined)}
                  />
                )}
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor="new-lead-notes" error={errors.notes?.message}>
            <Textarea id="new-lead-notes" rows={3} {...register('notes')} />
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  required,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="text-state-error ml-1" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? <p className="text-state-error text-xs">{error}</p> : null}
    </div>
  );
}
