import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Minimal layout for the public signing route. Like `/p/[slug]`, it does NOT
 * mount the app shell or session gate: signers have no account. The token in
 * the URL is the credential, so the page is never indexed and never sends a
 * referrer that could leak it.
 */
export const metadata: Metadata = {
  title: 'Sign document',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SignLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-bg-subtle">{children}</div>;
}
