'use client';

import type { ProjectWithCreator } from '@botss/shared-types';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { portalListsProjectStatus, useUpdateProjectPortal } from '@/hooks/use-project-portal';

import { ProjectDangerZone } from './project-danger-zone';
import { ProjectInfoForm } from './project-info-form';
import { ProjectMembersSection } from './project-members-section';
import { ProjectWorkflowSection } from './project-workflow-section';

export function ProjectSettingsView({ project }: { project: ProjectWithCreator }) {
  return (
    <div className="space-y-5">
      <ProjectInfoForm project={project} />
      <ProjectMembersSection projectId={project.id} />
      <ProjectClientPortalSection project={project} />
      <ProjectWorkflowSection project={project} />
      <section className="border-line rounded-lg border bg-white p-5">
        <h2 className="text-ink text-base font-semibold">Integrations</h2>
        <p className="text-ink-muted mt-1 text-sm">Slack / GitHub / Linear sync - coming soon.</p>
      </section>
      <ProjectDangerZone project={project} />
    </div>
  );
}

/**
 * What the linked client sees of this project in the client portal. The API
 * allows the change for workspace owners and admins, org admins and the
 * project lead; anyone else gets a toast saying so.
 */
function ProjectClientPortalSection({ project }: { project: ProjectWithCreator }) {
  const update = useUpdateProjectPortal(project.id);
  // Absent flags read as the API defaults: shown, marked tasks only.
  const visible = project.portalVisible ?? true;
  const showAllTasks = project.portalShowAllTasks ?? false;

  return (
    <section
      aria-labelledby="project-portal-heading"
      className="border-line rounded-lg border bg-white p-5"
    >
      <h2 id="project-portal-heading" className="text-ink text-base font-semibold">
        Client portal
      </h2>
      {project.clientId ? (
        <>
          <p className="text-ink-muted mt-1 text-sm">
            What people at this project&apos;s client see when they sign in to their portal. Only
            workspace owners and admins, or the project lead, can change this.
          </p>
          <div className="mt-4 space-y-4">
            <div className="border-line flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="project-portal-visible"
                checked={visible}
                disabled={update.isPending}
                onCheckedChange={(v) => update.mutate({ portalVisible: v === true })}
                aria-describedby="project-portal-visible-help"
                className="mt-0.5"
              />
              <div className="min-w-0">
                <Label htmlFor="project-portal-visible" className="cursor-pointer leading-snug">
                  Show this project in the client portal
                </Label>
                <p id="project-portal-visible-help" className="text-ink-muted mt-1 text-xs">
                  {!visible
                    ? 'Hidden: the client does not see this project at all.'
                    : portalListsProjectStatus(project.status)
                      ? 'The client sees its progress, milestones and task list.'
                      : 'Drafts and archived projects are not shown. The client sees it once it is Active, On hold or Completed.'}
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-portal-tasks">Task list shows</Label>
              <Select
                value={showAllTasks ? 'all' : 'marked'}
                onValueChange={(v) => update.mutate({ portalShowAllTasks: v === 'all' })}
                disabled={update.isPending}
              >
                <SelectTrigger
                  id="project-portal-tasks"
                  className="sm:max-w-xs"
                  aria-describedby="project-portal-tasks-help"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="marked">Only tasks marked for the client</SelectItem>
                  <SelectItem value="all">All tasks</SelectItem>
                </SelectContent>
              </Select>
              <p id="project-portal-tasks-help" className="text-ink-muted text-xs">
                {showAllTasks
                  ? 'Every task in this project, including ones added later.'
                  : 'Turn on "Visible to client" in a task\'s panel to list it. Progress still counts every task.'}
              </p>
            </div>
          </div>
        </>
      ) : (
        <p className="text-ink-muted mt-1 text-sm">
          Link a client under Project info above to share this project in their client portal.
        </p>
      )}
    </section>
  );
}
