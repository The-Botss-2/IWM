'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

import { InvoiceEditor } from '@/components/financials/invoice-editor';
import { PageLoader } from '@/components/ui/loader';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';

/**
 * New invoice. Query parameters prefill it, which is how "Raise invoice" on a
 * contract milestone lands here: ?contractId=&milestoneId=&clientId=
 * &projectId=&currency=&description=&amount=
 */
export default function NewInvoicePage() {
  const { checking, allowed } = useRequireSystemRole(['ADMIN', 'SUPER_ADMIN', 'FINANCE']);
  if (checking || !allowed) return <PageLoader label="Loading" />;
  return (
    <Suspense fallback={<PageLoader label="Loading" />}>
      <NewInvoiceInner />
    </Suspense>
  );
}

function NewInvoiceInner() {
  const params = useSearchParams();
  const prefill = useMemo(
    () => ({
      clientId: params.get('clientId'),
      projectId: params.get('projectId'),
      contractId: params.get('contractId'),
      milestoneId: params.get('milestoneId'),
      currency: params.get('currency'),
      description: params.get('description'),
      amount: params.get('amount'),
    }),
    [params],
  );
  return <InvoiceEditor invoiceId={null} prefill={prefill} />;
}
