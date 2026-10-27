'use client';

import { use } from 'react';

import {
  PortalContractsSection,
  PortalInvoicesSection,
  PortalPaymentsSection,
} from '@/components/portal/billing-sections';
import { usePortalClient } from '@/components/portal/portal-context';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { BillingUnavailable } from '@/components/portal/portal-states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePortalBillingTab } from '@/hooks/use-portal';

export default function PortalBillingPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const client = usePortalClient(clientId);
  const [tab, setTab] = usePortalBillingTab();

  if (!client) return null;

  return (
    <div className="space-y-6">
      <PortalPageHeader
        title="Billing"
        description={`Invoices, contracts and payments between ${client.name} and ${client.agency.name}.`}
      />
      {/* The nav hides Billing from everyone but the main contact; a direct
          link still lands here, so answer it instead of firing a 403. */}
      {client.canSeeBilling ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Billing sections" className="w-full">
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
          </TabsList>
          <TabsContent value="invoices" className="pt-5">
            <PortalInvoicesSection clientId={client.id} />
          </TabsContent>
          <TabsContent value="contracts" className="pt-5">
            <PortalContractsSection clientId={client.id} />
          </TabsContent>
          <TabsContent value="payments" className="pt-5">
            <PortalPaymentsSection clientId={client.id} />
          </TabsContent>
        </Tabs>
      ) : (
        <BillingUnavailable />
      )}
    </div>
  );
}
