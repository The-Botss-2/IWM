'use client';

import { use } from 'react';

import { SigningView } from '@/components/signatures/signing-view';

/**
 * The emailed signing link. The token in the URL plus the 6-digit code from
 * the same email (asked for first) are the credential; the page itself lives
 * in SigningView, shared with the client portal.
 */
export default function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <SigningView source={{ kind: 'token', token }} />;
}
