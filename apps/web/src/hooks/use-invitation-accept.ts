'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@botss/api-client';
import type { AcceptInvitationResponse, InvitationInfo } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { describeError } from '@/lib/toast';

export type InvitationState =
  | { kind: 'missing' }
  | { kind: 'loading' }
  /** Workspace invites: waiting for the 6-digit code from the email. */
  | { kind: 'code'; error: string | null }
  | { kind: 'invalid'; title: string; message: string }
  | { kind: 'ready'; info: InvitationInfo }
  | { kind: 'success'; destination: AcceptInvitationResponse['destination'] };

function statusOf(err: unknown): number {
  return err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
    ? err.status
    : 500;
}

function invalidCopy(err: unknown): { title: string; message: string } {
  const status = statusOf(err);
  if (status === 423) {
    return {
      title: 'Invitation locked',
      message: describeError(
        err,
        'Too many wrong codes were entered. Ask whoever invited you to send it again.',
      ),
    };
  }
  return {
    title: 'Invitation unavailable',
    message:
      status === 410
        ? 'This invitation has expired. Ask whoever sent it for a new one.'
        : status === 404
          ? 'This invitation link is not valid any more. Ask whoever sent it for a new one.'
          : 'Something went wrong loading the invitation.',
  };
}

/**
 * The `/invitations/accept` flow: preview the link, ask for the emailed code
 * when the link needs one, verify it, then set the first password and sign
 * in. `token` is the 32-byte link token; a URL that only carries a 6-digit
 * `code` (the old format) is treated as missing.
 */
export function useInvitationAccept(token: string | null) {
  const [state, setState] = useState<InvitationState>(
    token ? { kind: 'loading' } : { kind: 'missing' },
  );
  // The verified code, re-sent with accept. Memory only.
  const codeRef = useRef<string | undefined>(undefined);

  const verify = useCallback(
    async (code: string | undefined) => {
      if (!token) return;
      try {
        const info = await getApi().invitations.verify(token, code ? { code } : {});
        codeRef.current = code;
        setState({ kind: 'ready', info });
      } catch (err) {
        if (statusOf(err) === 401) {
          setState({ kind: 'code', error: describeError(err, 'That code is not right.') });
          return;
        }
        setState({ kind: 'invalid', ...invalidCopy(err) });
      }
    },
    [token],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const preview = await getApi().invitations.preview(token);
        if (cancelled) return;
        if (preview.requiresCode) setState({ kind: 'code', error: null });
        else await verify(undefined);
      } catch (err) {
        if (!cancelled) setState({ kind: 'invalid', ...invalidCopy(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, verify]);

  const submitCode = useCallback(
    (code: string) => {
      setState({ kind: 'loading' });
      void verify(code.trim());
    },
    [verify],
  );

  /** Set the password, then sign in. Returns an error message, or null. */
  const accept = useCallback(
    async (info: InvitationInfo, password: string): Promise<string | null> => {
      if (!token) return 'This invitation link is not valid.';
      try {
        const accepted = await getApi().invitations.accept(token, {
          password,
          ...(codeRef.current ? { code: codeRef.current } : {}),
        });
        // Create the Better Auth session by signing in with the credentials
        // just set. This avoids the API ever holding a Better Auth handle.
        const res = await authClient.signIn.email({ email: info.email, password });
        if (res.error) {
          return describeError(
            res.error,
            "Password set, but we couldn't sign you in. Sign in manually.",
          );
        }
        setState({ kind: 'success', destination: accepted.destination });
        return null;
      } catch (err) {
        // The account got a password in the meantime (for example through
        // another invite): show the sign-in view instead of a dead form.
        if (err instanceof ApiError && err.problem.code === 'already-set-up') {
          setState({ kind: 'ready', info: { ...info, hasPassword: true } });
          return null;
        }
        if (statusOf(err) === 423) {
          setState({ kind: 'invalid', ...invalidCopy(err) });
          return null;
        }
        return describeError(err, "Couldn't accept the invitation.");
      }
    },
    [token],
  );

  return { state, submitCode, accept };
}
