'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '@botss/api-client';
import {
  inviteClientContactSchema,
  type ClientContact,
  type ClientContactList,
  type ClientContactRole,
  type InviteClientContactInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { describeError, toastErrorMessage } from '@/lib/toast';
import { documentAccessRootKey, documentShareTargetsRootKey } from './use-document-access';

/**
 * Client portal, staff side: who at a client may sign in to the portal.
 * Nested under the client's own key, so dropping a client's cache drops
 * this list with it.
 */
const clientPortalContactsKey = (clientId: string) =>
  ['clients', clientId, 'portal-contacts'] as const;

export function useClientPortalContacts(clientId: string) {
  return useQuery({
    queryKey: clientPortalContactsKey(clientId),
    queryFn: () => getApi().clients.portalContacts(clientId),
    enabled: !!clientId,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Errors and form input
// ---------------------------------------------------------------------------

const MANAGE_FORBIDDEN = 'Only workspace owners and admins can change who has portal access.';

/** Readable copy for a failed portal-contact request. */
export function portalContactErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.code === 'staff-account') {
      return 'This email belongs to someone on your team. Portal access needs a separate email address.';
    }
    if (err.problem.code === 'email-unavailable') {
      return "This email can't be used for a portal login. Use a different email address.";
    }
    // One portal login belongs to one team: the API refuses an email that
    // already has a portal login elsewhere, since its password is shared.
    if (err.problem.code === 'client-portal-account-elsewhere') {
      return 'This email already has a client portal login with another team. Use a different email for this person.';
    }
    if (err.status === 403) return MANAGE_FORBIDDEN;
  }
  return describeError(err, fallback);
}

export type PortalInviteForm = { email: string; name: string; role: ClientContactRole };

export type PortalInviteParse =
  | { ok: true; input: InviteClientContactInput }
  | { ok: false; error: string };

/** Validate the invite form with the same schema the API uses. */
export function parsePortalInvite(form: PortalInviteForm): PortalInviteParse {
  const parsed = inviteClientContactSchema.safeParse({
    email: form.email,
    role: form.role,
    ...(form.name.trim() ? { name: form.name } : {}),
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  if (field === 'email') {
    return {
      ok: false,
      error: form.email.trim() ? 'Enter a valid email address.' : 'Enter an email address.',
    };
  }
  if (field === 'name') return { ok: false, error: 'Keep the name under 100 characters.' };
  return { ok: false, error: 'Check the details and try again.' };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Server order: the main contact first, then everyone by invite date. */
function sortContacts(items: ClientContact[]): ClientContact[] {
  return [...items].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'PRIMARY' ? -1 : 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/** One main contact per client: promoting someone demotes the current one. */
function withRole(items: ClientContact[], contactId: string, role: ClientContactRole): ClientContact[] {
  return items.map((c) => {
    if (c.id === contactId) return { ...c, role };
    if (role === 'PRIMARY' && c.role === 'PRIMARY') return { ...c, role: 'MEMBER' };
    return c;
  });
}

function upsertContact(
  prev: ClientContactList | undefined,
  contact: ClientContact,
): ClientContactList | undefined {
  if (!prev) return prev;
  const others = prev.items.filter((c) => c.id !== contact.id);
  return {
    ...prev,
    items: sortContacts(withRole([...others, contact], contact.id, contact.role)),
  };
}

function refreshContacts(qc: QueryClient, clientId: string) {
  return qc.invalidateQueries({ queryKey: clientPortalContactsKey(clientId) });
}

/**
 * Document share dialogs list each client's portal people, so a change here
 * makes them stale. The access lists are pinned (no refetch on mount), so the
 * ones not on screen are dropped and load fresh next time.
 */
function refreshDocumentSharing(qc: QueryClient, opts: { accessLists: boolean }) {
  void qc.invalidateQueries({ queryKey: documentShareTargetsRootKey });
  if (opts.accessLists) {
    qc.removeQueries({ queryKey: documentAccessRootKey, type: 'inactive' });
    void qc.invalidateQueries({ queryKey: documentAccessRootKey, type: 'active' });
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Invite someone at the client. No error toast: the invite dialog shows the
 * reason next to the form (see `portalContactErrorMessage`).
 */
export function useInvitePortalContact(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't invite contact" },
    mutationFn: (input: InviteClientContactInput) =>
      getApi().clients.invitePortalContact(clientId, input),
    onSuccess: (result) => {
      qc.setQueryData<ClientContactList>(clientPortalContactsKey(clientId), (prev) =>
        upsertContact(prev, result.contact),
      );
      void refreshContacts(qc, clientId);
      refreshDocumentSharing(qc, { accessLists: false });
    },
  });
}

/** A fresh invite link for someone who has not set a password yet. */
export function useResendPortalInvite(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't resend invite" },
    mutationFn: (contactId: string) => getApi().clients.resendPortalInvite(clientId, contactId),
    onSuccess: (result) => {
      qc.setQueryData<ClientContactList>(clientPortalContactsKey(clientId), (prev) =>
        upsertContact(prev, result.contact),
      );
    },
    onError: (err) => toastErrorMessage("Couldn't resend the invite", {
        description: portalContactErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      }),
    // A 409 here usually means they accepted meanwhile, so refetch either way.
    onSettled: () => refreshContacts(qc, clientId),
  });
}

/** A new-password link for someone who has already set one. */
export function useSendPortalPasswordReset(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't send password reset link" },
    mutationFn: (contactId: string) =>
      getApi().clients.sendPortalPasswordReset(clientId, contactId),
    onSuccess: (result) => {
      qc.setQueryData<ClientContactList>(clientPortalContactsKey(clientId), (prev) =>
        upsertContact(prev, result.contact),
      );
    },
    onError: (err) =>
      toastErrorMessage("Couldn't send the password reset link", {
        description: portalContactErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      }),
    onSettled: () => refreshContacts(qc, clientId),
  });
}

export function useSetPortalContactRole(clientId: string) {
  const qc = useQueryClient();
  const key = clientPortalContactsKey(clientId);
  return useMutation({
    meta: { errorTitle: "Couldn't change contact role" },
    mutationFn: ({ contactId, role }: { contactId: string; role: ClientContactRole }) =>
      getApi().clients.updatePortalContact(clientId, contactId, { role }),
    onMutate: async ({ contactId, role }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ClientContactList>(key);
      if (previous) {
        qc.setQueryData<ClientContactList>(key, {
          ...previous,
          items: sortContacts(withRole(previous.items, contactId, role)),
        });
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toastErrorMessage("Couldn't change the main contact", {
        description: portalContactErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      });
    },
    onSettled: () => refreshContacts(qc, clientId),
  });
}

/** Revoke portal access. The API also drops their personal document shares. */
export function useRevokePortalContact(clientId: string) {
  const qc = useQueryClient();
  const key = clientPortalContactsKey(clientId);
  return useMutation({
    meta: { errorTitle: "Couldn't revoke portal access" },
    mutationFn: (contactId: string) => getApi().clients.revokePortalContact(clientId, contactId),
    onMutate: async (contactId) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ClientContactList>(key);
      if (previous) {
        qc.setQueryData<ClientContactList>(key, {
          ...previous,
          items: previous.items.filter((c) => c.id !== contactId),
        });
      }
      return { previous };
    },
    onSuccess: () => refreshDocumentSharing(qc, { accessLists: true }),
    onError: (err, _contactId, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toastErrorMessage("Couldn't remove portal access", {
        description: portalContactErrorMessage(err, 'Something unexpected happened. Try again in a moment.'),
      });
    },
    onSettled: () => refreshContacts(qc, clientId),
  });
}
