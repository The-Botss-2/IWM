'use client';

import {
  ChevronRight,
  FileSignature,
  FileText,
  FolderKanban,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { use, type ReactNode } from 'react';
import type { PortalClientSummary, PortalOverview } from '@botss/shared-types';

import { greeting, plural } from '@/components/portal/format';
import { usePortalClient, usePortalMe } from '@/components/portal/portal-context';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { PortalEmpty } from '@/components/portal/portal-states';
import { PortalProjectCard } from '@/components/portal/project-card';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { portalHref, usePortalOverview } from '@/hooks/use-portal';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

/** How many projects the overview shows before pointing at the full list. */
const OVERVIEW_PROJECTS = 4;

export default function PortalOverviewPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const me = usePortalMe();
  const client = usePortalClient(clientId);
  const overview = usePortalOverview(clientId);

  // The [clientId] layout already renders "not found" for a client that is
  // not theirs.
  if (!client) return null;

  return (
    <div className="space-y-8">
      <PortalPageHeader
        title={greeting(me.user.name)}
        description={`Here is the latest from ${client.agency.name} for ${client.name}.`}
      />
      {overview.isLoading ? (
        <OverviewSkeleton />
      ) : overview.isError || !overview.data ? (
        <QueryError
          message="Couldn't load your overview."
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <OverviewBody client={client} overview={overview.data} />
      )}
    </div>
  );
}

function OverviewBody({
  client,
  overview,
}: {
  client: PortalClientSummary;
  overview: PortalOverview;
}) {
  const { projects, pendingSignatures, sharedDocuments, outstanding } = overview;
  const shown = projects.slice(0, OVERVIEW_PROJECTS);

  return (
    <>
      <section aria-label="At a glance">
        <ul className={cn('grid gap-4 sm:grid-cols-2', outstanding && 'lg:grid-cols-3')}>
          <li>
            <GlanceCard
              href={portalHref(client.id, 'signatures')}
              icon={FileSignature}
              label="Signatures"
              attention={pendingSignatures > 0}
            >
              {pendingSignatures > 0 ? (
                <>
                  <p className="text-ink text-2xl font-bold tabular-nums">{pendingSignatures}</p>
                  <p className="text-ink-muted text-sm">
                    {plural(pendingSignatures, 'document', 'documents')} waiting for your signature
                  </p>
                  <p className="text-brand-700 pt-1 text-sm font-medium">Review and sign</p>
                </>
              ) : (
                <>
                  <p className="text-ink text-base font-medium">Nothing to sign right now</p>
                  <p className="text-ink-muted text-sm">
                    Documents that need your signature will show up here.
                  </p>
                </>
              )}
            </GlanceCard>
          </li>
          <li>
            <GlanceCard href={portalHref(client.id, 'documents')} icon={FileText} label="Documents">
              {sharedDocuments > 0 ? (
                <>
                  <p className="text-ink text-2xl font-bold tabular-nums">{sharedDocuments}</p>
                  <p className="text-ink-muted text-sm">
                    {plural(sharedDocuments, 'document', 'documents')} shared with you
                  </p>
                </>
              ) : (
                <>
                  <p className="text-ink text-base font-medium">No documents yet</p>
                  <p className="text-ink-muted text-sm">
                    Documents {client.agency.name} shares with you will show up here.
                  </p>
                </>
              )}
            </GlanceCard>
          </li>
          {outstanding ? (
            <li>
              <GlanceCard href={portalHref(client.id, 'billing')} icon={Wallet} label="Outstanding">
                {outstanding.length === 0 ? (
                  <>
                    <p className="text-ink text-base font-medium">Nothing outstanding</p>
                    <p className="text-ink-muted text-sm">You are all paid up.</p>
                  </>
                ) : (
                  // One line per currency: amounts in different currencies
                  // are never added together.
                  <ul className="space-y-2">
                    {outstanding.map((row) => (
                      <li key={row.currency}>
                        <p className="text-ink text-xl font-bold tabular-nums">
                          {formatCurrency(row.amount, row.currency)}
                        </p>
                        <p className="text-ink-muted text-sm">
                          {row.invoiceCount} open {plural(row.invoiceCount, 'invoice', 'invoices')}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </GlanceCard>
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-labelledby="overview-projects" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="overview-projects" className="text-ink text-lg font-semibold">
            Projects
          </h2>
          {projects.length > shown.length ? (
            <Link
              href={portalHref(client.id, 'projects')}
              className="text-brand-700 focus-visible:ring-brand-purple/50 rounded-md text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2"
            >
              View all {projects.length}
            </Link>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <PortalEmpty
            icon={FolderKanban}
            title="No projects to show yet"
            description={`When ${client.agency.name} shares a project with you, its progress appears here.`}
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {shown.map((project) => (
              <li key={project.id}>
                <PortalProjectCard clientId={client.id} project={project} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function GlanceCard({
  href,
  icon: Icon,
  label,
  attention = false,
  children,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Something is waiting on the person: tint the card so it reads first. */
  attention?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'card hover:shadow-soft-lg flex h-full flex-col gap-3 p-5 transition-shadow duration-200',
        'focus-visible:ring-brand-purple/50 focus-visible:outline-none focus-visible:ring-2',
        attention && 'bg-brand-50 ring-brand-purple/20 ring-1 ring-inset',
      )}
    >
      <span className="text-ink-muted flex items-center gap-2 text-sm font-medium">
        <Icon className={cn('h-4 w-4', attention && 'text-brand-purple')} aria-hidden />
        {label}
        <ChevronRight className="text-ink-disabled ml-auto h-4 w-4" aria-hidden />
      </span>
      <div className="space-y-1">{children}</div>
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
