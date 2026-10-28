'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { mailHost } from '@botss/shared-types';

import { OrgMailFields } from '@/components/organization/org-mail-fields';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useOrgMailConfig, useUpsertOrgMailConfig } from '@/hooks/use-org-mail-config';

/**
 * Form schema for the in-app editor. Passwords are blank-able: an empty string
 * means "keep the stored value", so we DON'T enforce min(1) here. Empty
 * passwords are stripped before the API call (which only accepts present, non
 * empty passwords).
 */
const formSchema = z.object({
  smtpHost: mailHost,
  smtpPort: z.number().int().positive().max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().min(1).max(255),
  smtpPassword: z.string().max(255).optional(),
  imapHost: mailHost,
  imapPort: z.number().int().positive().max(65535),
  imapSecure: z.boolean(),
  imapUser: z.string().min(1).max(255),
  imapPassword: z.string().max(255).optional(),
  fromEmail: z.string().email(),
});
type FormValues = z.infer<typeof formSchema>;

export default function OrganizationMailSettingsPage() {
  const config = useOrgMailConfig();
  const upsert = useUpsertOrgMailConfig();
  const existing = config.data?.config ?? null;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  // Populate the form once the current config loads. Passwords stay blank -
  // the server never returns them; leaving them blank keeps the stored values.
  useEffect(() => {
    if (existing) {
      reset({
        smtpHost: existing.smtpHost,
        smtpPort: existing.smtpPort,
        smtpSecure: existing.smtpSecure,
        smtpUser: existing.smtpUser,
        smtpPassword: '',
        imapHost: existing.imapHost,
        imapPort: existing.imapPort,
        imapSecure: existing.imapSecure,
        imapUser: existing.imapUser,
        imapPassword: '',
        fromEmail: existing.fromEmail,
      });
    }
  }, [existing, reset]);

  const onSubmit = (data: FormValues) => {
    // Strip blank passwords so the API treats them as "unchanged" rather than
    // rejecting an empty string.
    const { smtpPassword, imapPassword, ...rest } = data;
    upsert.mutate({
      ...rest,
      ...(smtpPassword ? { smtpPassword } : {}),
      ...(imapPassword ? { imapPassword } : {}),
    });
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-ink text-lg font-semibold">Organization email</h2>
        <p className="text-ink-muted mt-1 text-sm">
          SMTP/IMAP credentials your organization uses to send and receive mail (workspace
          invitations, password resets, and the Mail feature). Only the workspace owner and admins
          can change these.
        </p>
      </header>

      {config.isLoading ? (
        <div className="border-line bg-bg-surface rounded-md border p-6 text-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : config.isError && !config.data ? (
        <QueryError message="Couldn't load email settings." onRetry={() => void config.refetch()} />
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit(onSubmit)} noValidate>
          {!existing ? (
            <p className="border-line bg-bg-subtle text-ink-muted rounded-md border px-3 py-2 text-xs">
              No email configured yet. Fill in both SMTP and IMAP details (including passwords) to
              enable mail for your organization.
            </p>
          ) : null}

          <OrgMailFields
            register={register}
            errors={errors}
            passwordsRequired={!existing}
            passwordPlaceholder={existing ? '•••••••• (unchanged)' : undefined}
          />

          <div className="flex justify-end">
            <Button type="submit" disabled={isSubmitting || upsert.isPending}>
              {upsert.isPending ? 'Saving…' : 'Save email settings'}
            </Button>
          </div>
        </form>
      )}

      <section className="border-line bg-bg-subtle text-ink-muted rounded-md border px-4 py-3 text-xs">
        <p className="text-ink font-medium">Security</p>
        <p className="mt-1">
          Passwords are encrypted with AES-256-GCM before storage and are never returned by the API.
          Leave a password blank to keep the stored value.
        </p>
      </section>
    </div>
  );
}
