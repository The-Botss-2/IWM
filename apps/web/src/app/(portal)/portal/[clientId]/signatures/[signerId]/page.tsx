'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { SigningView } from '@/components/signatures/signing-view';
import { Button } from '@/components/ui/button';

/** Signing inside the client portal: the same view as the emailed link. */
export default function PortalSignPage() {
  const { clientId, signerId } = useParams<{ clientId: string; signerId: string }>();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-3">
        <Link href={`/portal/${clientId}/signatures`}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to signatures
        </Link>
      </Button>
      {/* Keyed so another request never inherits this one's adopted signature. */}
      <SigningView key={`${clientId}:${signerId}`} source={{ kind: 'portal', clientId, signerId }} />
    </div>
  );
}
