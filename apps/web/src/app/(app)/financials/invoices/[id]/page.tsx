'use client';

import { use } from 'react';

import { InvoiceEditor } from '@/components/financials/invoice-editor';
import { PageLoader } from '@/components/ui/loader';
import { useRequireSystemRole } from '@/hooks/use-require-system-role';

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { checking, allowed } = useRequireSystemRole(['ADMIN', 'SUPER_ADMIN', 'FINANCE']);
  if (checking || !allowed) return <PageLoader label="Loading" />;
  return <InvoiceEditor key={id} invoiceId={id} />;
}
