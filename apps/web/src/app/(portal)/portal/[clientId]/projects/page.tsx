'use client';

import { FolderKanban } from 'lucide-react';
import { use } from 'react';

import { usePortalClient } from '@/components/portal/portal-context';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { PortalEmpty } from '@/components/portal/portal-states';
import { PortalProjectCard } from '@/components/portal/project-card';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortalProjects } from '@/hooks/use-portal';

export default function PortalProjectsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const client = usePortalClient(clientId);
  const projects = usePortalProjects(clientId);

  if (!client) return null;
  const items = projects.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PortalPageHeader
        title="Projects"
        description={`Projects ${client.agency.name} has shared with ${client.name}, and how far along each one is.`}
      />
      {projects.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : projects.isError ? (
        <QueryError message="Couldn't load projects." onRetry={() => void projects.refetch()} />
      ) : items.length === 0 ? (
        <PortalEmpty
          icon={FolderKanban}
          title="No projects to show yet"
          description={`When ${client.agency.name} shares a project with you, its progress appears here.`}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((project) => (
            <li key={project.id}>
              <PortalProjectCard clientId={client.id} project={project} headingLevel="h2" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
