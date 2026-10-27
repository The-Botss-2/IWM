'use client';

import {
  Activity,
  Briefcase,
  DoorOpen,
  FileSignature,
  FileText,
  Info,
  Receipt,
  Settings,
  StickyNote,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useCallback } from 'react';

import { ClientActivityFeed } from '@/components/clients/client-activity-feed';
import { ClientStatusBadge } from '@/components/clients/client-badges';
import { ClientBillingTab } from '@/components/clients/client-billing-tab';
import { ClientDocumentsTab } from '@/components/clients/client-documents-tab';
import { ClientNotes } from '@/components/clients/client-notes';
import { ClientOverview } from '@/components/clients/client-overview';
import { ClientPortalTab } from '@/components/clients/client-portal-tab';
import { ClientProjects } from '@/components/clients/client-projects';
import { ClientSettings } from '@/components/clients/client-settings';
import { ClientSignaturesTab } from '@/components/clients/client-signatures-tab';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useClient } from '@/hooks/use-clients';
import { useFinanceAccess } from '@/hooks/use-finance-access';

const TABS = [
  'overview',
  'projects',
  'documents',
  'signatures',
  'billing',
  'portal',
  'notes',
  'activity',
  'settings',
] as const;
type ClientTab = (typeof TABS)[number];
const DEFAULT_TAB: ClientTab = 'overview';

/** Billing is for finance roles only; anyone else lands on the overview. */
function parseTab(value: string | null | undefined, canSeeBilling: boolean): ClientTab {
  if (!value) return DEFAULT_TAB;
  if (!(TABS as readonly string[]).includes(value)) return DEFAULT_TAB;
  if (value === 'billing' && !canSeeBilling) return DEFAULT_TAB;
  return value as ClientTab;
}

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const client = useClient(id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const finance = useFinanceAccess();
  const tab = parseTab(searchParams.get('tab'), finance.allowed);

  const setTab = useCallback(
    (next: ClientTab) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (next === DEFAULT_TAB) sp.delete('tab');
      else sp.set('tab', next);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [searchParams, router],
  );

  if (client.isLoading) {
    return (
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (client.isError || !client.data) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 text-sm text-state-error sm:px-6 lg:px-8">
        Couldn&apos;t load client.{' '}
        <Link href="/clients" className="underline">
          Back to clients
        </Link>
      </div>
    );
  }

  const c = client.data;

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <Link href="/clients" className="text-sm text-ink-muted hover:text-ink">
          ← Clients
        </Link>
      </div>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{c.name}</h1>
            <ClientStatusBadge status={c.status} />
          </div>
          {c.legalName ? (
            <p className="mt-1 text-sm text-ink-muted">{c.legalName}</p>
          ) : null}
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as ClientTab)}>
        <TabsList className="-mx-1 px-1 w-full sm:w-auto">
          <TabsTrigger value="overview">
            <Info className="h-4 w-4" aria-hidden />
            <span>Overview</span>
          </TabsTrigger>
          <TabsTrigger value="projects">
            <Briefcase className="h-4 w-4" aria-hidden />
            <span>Projects</span>
          </TabsTrigger>
          <TabsTrigger value="documents">
            <FileText className="h-4 w-4" aria-hidden />
            <span>Documents</span>
          </TabsTrigger>
          <TabsTrigger value="signatures">
            <FileSignature className="h-4 w-4" aria-hidden />
            <span>Signatures</span>
          </TabsTrigger>
          {finance.allowed ? (
            <TabsTrigger value="billing">
              <Receipt className="h-4 w-4" aria-hidden />
              <span>Billing</span>
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="portal">
            <DoorOpen className="h-4 w-4" aria-hidden />
            <span>Portal</span>
          </TabsTrigger>
          <TabsTrigger value="notes">
            <StickyNote className="h-4 w-4" aria-hidden />
            <span>Notes</span>
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Activity className="h-4 w-4" aria-hidden />
            <span>Activity</span>
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-4 w-4" aria-hidden />
            <span>Settings</span>
          </TabsTrigger>
        </TabsList>

        <div className="pt-4">
          <TabsContent value="overview">
            <ClientOverview client={c} />
          </TabsContent>
          <TabsContent value="projects">
            <ClientProjects clientId={c.id} />
          </TabsContent>
          <TabsContent value="documents">
            <ClientDocumentsTab clientId={c.id} clientName={c.name} />
          </TabsContent>
          <TabsContent value="signatures">
            <ClientSignaturesTab clientId={c.id} />
          </TabsContent>
          {finance.allowed ? (
            <TabsContent value="billing">
              <ClientBillingTab clientId={c.id} />
            </TabsContent>
          ) : null}
          <TabsContent value="portal">
            <ClientPortalTab clientId={c.id} clientName={c.name} />
          </TabsContent>
          <TabsContent value="notes">
            <ClientNotes client={c} />
          </TabsContent>
          <TabsContent value="activity">
            <ClientActivityFeed clientId={c.id} />
          </TabsContent>
          <TabsContent value="settings">
            <ClientSettings client={c} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
