'use client';

import { KeyRound, LockKeyhole, SearchX, WifiOff, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { usePortalSignOut } from '@/hooks/use-portal';
import { cn } from '@/lib/utils';

/** A round, muted icon plate used by every portal state below. */
function StateIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid h-12 w-12 place-items-center rounded-full bg-bg-subtle text-ink-muted">
      <Icon className="h-5 w-5" aria-hidden />
    </span>
  );
}

/** Centers a short message: the whole screen for the gate, the content area inside the shell. */
export function PortalCentered({
  children,
  fullScreen = false,
}: {
  children: ReactNode;
  fullScreen?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid place-items-center px-4 py-10',
        fullScreen ? 'min-h-screen' : 'min-h-[50vh]',
      )}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">{children}</div>
    </div>
  );
}

/**
 * The portal could not load. Offline mirrors the internal app's gate: the
 * cookie is untouched, so say so and offer a retry. Any other failure also
 * offers a way out, in case retrying cannot help.
 */
export function PortalLoadError({
  offline,
  onRetry,
  retrying,
}: {
  offline: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const signOut = usePortalSignOut();
  return (
    <PortalCentered fullScreen>
      <StateIcon icon={offline ? WifiOff : SearchX} />
      <p className="text-sm font-medium text-ink">
        {offline ? "Can't reach the server" : "We couldn't open your portal"}
      </p>
      <p className="text-sm text-ink-muted">
        {offline
          ? 'You are still signed in. Check your connection, then try again.'
          : 'Something went wrong on our side. Try again in a moment.'}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying' : 'Try again'}
        </Button>
        {offline ? null : (
          <Button variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            Sign out
          </Button>
        )}
      </div>
    </PortalCentered>
  );
}

/** Signed in, but no longer a contact of any client. */
export function PortalNoAccess({ fullScreen = false }: { fullScreen?: boolean }) {
  const signOut = usePortalSignOut();
  return (
    <PortalCentered fullScreen={fullScreen}>
      <StateIcon icon={KeyRound} />
      <h1 className="text-lg font-semibold text-ink">Your portal access has been removed</h1>
      <p className="text-sm text-ink-muted">
        This account is not linked to any client right now. If you think that is a mistake,
        contact the team that invited you.
      </p>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        {signOut.isPending ? 'Signing out' : 'Sign out'}
      </Button>
    </PortalCentered>
  );
}

/** Something that is not (or no longer) shared with this person. */
export function PortalUnavailable({
  title,
  description,
  href,
  linkLabel,
}: {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <PortalCentered>
      <StateIcon icon={SearchX} />
      <h1 className="text-lg font-semibold text-ink">{title}</h1>
      <p className="text-sm text-ink-muted">{description}</p>
      <Button asChild variant="secondary" className="mt-2">
        <Link href={href}>{linkLabel}</Link>
      </Button>
    </PortalCentered>
  );
}

/** An empty list: what will appear here, and when. */
export function PortalEmpty({
  icon,
  title,
  description,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong bg-bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      <StateIcon icon={icon} />
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <p className="max-w-sm text-sm text-ink-muted">{description}</p> : null}
    </div>
  );
}

/** Shown to everyone but the main contact, whether the UI or the API said so. */
export function BillingUnavailable() {
  return (
    <PortalEmpty
      icon={LockKeyhole}
      title="Billing is available to your main contact."
      description="Invoices, contracts and payments are shared with your company's main contact. Ask them if you need a copy."
    />
  );
}
