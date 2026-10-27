import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type ClientCustomFieldValueList,
  clientCustomFieldValueListSchema,
  type CreateCustomFieldDefinitionInput,
  type CustomFieldDefinition,
  type CustomFieldScope,
  type CustomFieldValue,
  customFieldValueSchema,
  type ListCustomFieldDefinitionsQuery,
  type SetClientCustomFieldInput,
  type SetCustomFieldValueInput,
  type UpdateCustomFieldDefinitionInput,
} from '@botss/shared-types';
import { Prisma } from '@botss/database';
import type { AppAbility } from '@botss/auth';

import { requireVisibleClient, requireWritableClient } from '../clients/client-visibility';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { abilityRow } from '../common/permissions/request-ability';
import { projectAccessWhere } from '../common/project-access';
import { invalidReference, orgWorkspaceMembership } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import {
  customFieldValueProblem,
  GENERIC_VALUE_SCOPES,
  isGenericValueScope,
} from './custom-field-rules';

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Access helpers
  // -------------------------------------------------------------------------

  private requireWorkspace(scope: UserScope): string {
    if (!scope.currentWorkspaceId || scope.workspaceIds.length === 0) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Active workspace required to manage custom fields.',
      });
    }
    return scope.currentWorkspaceId;
  }

  private async assertWorkspaceAdmin(scope: UserScope, workspaceId: string): Promise<void> {
    const membership = await orgWorkspaceMembership(this.prisma, scope.userId, workspaceId);
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only workspace owners or admins can manage custom field definitions.',
      });
    }
  }

  private async assertProjectAccess(scope: UserScope, projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findFirst({
      where: {
        id: projectId,
        ...(projectAccessWhere(scope) as Prisma.ProjectWhereInput),
      },
      select: { id: true },
    });
    if (!project) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that project.',
      });
    }
  }

  private validateScopeShape(scope: CustomFieldScope, projectId: string | null | undefined) {
    if (scope === 'TASK' && !projectId) {
      throw new BadRequestException({
        title: 'Invalid scope',
        status: 400,
        detail: 'TASK-scoped fields require a projectId.',
      });
    }
    if ((scope === 'LEAD' || scope === 'CLIENT') && projectId) {
      throw new BadRequestException({
        title: 'Invalid scope',
        status: 400,
        detail: `${scope}-scoped fields must not have a projectId.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  async listDefinitions(
    scope: UserScope,
    query: ListCustomFieldDefinitionsQuery,
  ): Promise<CustomFieldDefinition[]> {
    const workspaceId = this.requireWorkspace(scope);
    if (query.projectId) await this.assertProjectAccess(scope, query.projectId);

    const where: Prisma.CustomFieldDefinitionWhereInput = { workspaceId };
    if (query.scope) where.scope = query.scope;
    if (query.projectId !== undefined) where.projectId = query.projectId;

    const rows = await this.prisma.client.customFieldDefinition.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      ...r,
      options: (r.options as CustomFieldDefinition['options']) ?? null,
    }));
  }

  async createDefinition(
    scope: UserScope,
    input: CreateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinition> {
    const workspaceId = this.requireWorkspace(scope);
    await this.assertWorkspaceAdmin(scope, workspaceId);
    this.validateScopeShape(input.scope, input.projectId ?? null);
    if (input.projectId) await this.assertProjectAccess(scope, input.projectId);

    if (
      (input.type === 'SELECT' || input.type === 'MULTI_SELECT') &&
      (!input.options || input.options.length === 0)
    ) {
      throw new BadRequestException({
        title: 'Invalid options',
        status: 400,
        detail: 'SELECT / MULTI_SELECT fields require at least one option.',
      });
    }

    const created = await this.prisma.client.customFieldDefinition.create({
      data: {
        workspaceId,
        scope: input.scope,
        projectId: input.projectId ?? null,
        name: input.name,
        key: input.key,
        type: input.type,
        options: input.options
          ? (input.options as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        required: input.required ?? false,
        position: input.position ?? 0,
      },
    });
    return { ...created, options: (created.options as CustomFieldDefinition['options']) ?? null };
  }

  async updateDefinition(
    scope: UserScope,
    id: string,
    input: UpdateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinition> {
    const workspaceId = this.requireWorkspace(scope);
    await this.assertWorkspaceAdmin(scope, workspaceId);
    const existing = await this.prisma.client.customFieldDefinition.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException({
        title: 'Definition not found',
        status: 404,
      });
    }

    const data: Prisma.CustomFieldDefinitionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.required !== undefined) data.required = input.required;
    if (input.position !== undefined) data.position = input.position;
    if (input.options !== undefined) {
      data.options = input.options
        ? (input.options as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
    }

    const updated = await this.prisma.client.customFieldDefinition.update({
      where: { id },
      data,
    });
    return { ...updated, options: (updated.options as CustomFieldDefinition['options']) ?? null };
  }

  async deleteDefinition(scope: UserScope, id: string): Promise<void> {
    const workspaceId = this.requireWorkspace(scope);
    await this.assertWorkspaceAdmin(scope, workspaceId);
    const existing = await this.prisma.client.customFieldDefinition.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException({
        title: 'Definition not found',
        status: 404,
      });
    }
    await this.prisma.client.customFieldDefinition.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Values (upsert pattern - definitionId + entityId is unique)
  //
  // The generic routes serve PROJECT and TASK fields only. CLIENT and LEAD
  // values live on records with their own visibility (assignment, finance
  // read access), which these routes cannot check, so they are refused here;
  // CLIENT values go through the client hub routes below.
  // -------------------------------------------------------------------------

  async listValues(scope: UserScope, entityId: string): Promise<CustomFieldValue[]> {
    this.requireWorkspace(scope);
    // The entity must be a project or task the caller can see; anything else
    // lists nothing, whatever workspace it lives in.
    const [project, task] = await Promise.all([
      this.prisma.client.project.findFirst({
        where: { id: entityId, deletedAt: null, AND: [projectAccessWhere(scope)] },
        select: { workspaceId: true },
      }),
      this.prisma.client.task.findFirst({
        where: { id: entityId, deletedAt: null, project: projectAccessWhere(scope) },
        select: { project: { select: { workspaceId: true } } },
      }),
    ]);
    const entity = project
      ? { scope: 'PROJECT' as const, workspaceId: project.workspaceId }
      : task
        ? { scope: 'TASK' as const, workspaceId: task.project.workspaceId }
        : null;
    if (!entity) return [];
    const rows = await this.prisma.client.customFieldValue.findMany({
      where: {
        entityId,
        definition: { workspaceId: entity.workspaceId, scope: entity.scope },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => customFieldValueSchema.parse(r));
  }

  /**
   * Every TASK-field value on the non-archived tasks of one project the
   * caller can see. Feeds the list view's custom-field columns in one read.
   */
  async listTaskValuesForProject(scope: UserScope, projectId: string): Promise<CustomFieldValue[]> {
    const workspaceId = this.requireWorkspace(scope);
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null, AND: [projectAccessWhere(scope)] },
      select: { id: true },
    });
    if (!project) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that project.',
      });
    }
    const tasks = await this.prisma.client.task.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true },
    });
    if (tasks.length === 0) return [];
    const rows = await this.prisma.client.customFieldValue.findMany({
      where: {
        entityId: { in: tasks.map((t) => t.id) },
        definition: { workspaceId, scope: 'TASK', projectId },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => customFieldValueSchema.parse(r));
  }

  /**
   * Writing a value is editing its record, so it takes the same right:
   * `update` on that task (or project), checked against the row so project
   * roles apply (a reviewer only while IN_REVIEW, a viewer never). The entity
   * must also be a project/task of `workspaceId` the caller can see, and a
   * task field pinned to a project only lands on that project's tasks.
   */
  private async assertMayWriteEntity(
    scope: UserScope,
    ability: AppAbility,
    workspaceId: string,
    definition: { scope: string; projectId: string | null },
    entityId: string,
    missing: () => Error = () => invalidReference('record', 'invalid_entity'),
  ): Promise<void> {
    if (definition.scope === 'PROJECT') {
      const project = await this.prisma.client.project.findFirst({
        where: { id: entityId, deletedAt: null, workspaceId, AND: [projectAccessWhere(scope)] },
        select: { id: true },
      });
      if (!project) throw missing();
      if (!ability.can('update', abilityRow('Project', { id: project.id }))) {
        throw cannotEditFields('project');
      }
      return;
    }
    const task = await this.prisma.client.task.findFirst({
      where: {
        id: entityId,
        deletedAt: null,
        project: { workspaceId, AND: [projectAccessWhere(scope)] },
      },
      select: { id: true, projectId: true, status: true, createdById: true, assigneeId: true },
    });
    if (!task || (definition.projectId !== null && task.projectId !== definition.projectId)) {
      throw missing();
    }
    if (!ability.can('update', abilityRow('Task', task))) throw cannotEditFields('task');
  }

  async setValue(
    scope: UserScope,
    ability: AppAbility,
    input: SetCustomFieldValueInput,
  ): Promise<CustomFieldValue> {
    const workspaceId = this.requireWorkspace(scope);
    const definition = await this.prisma.client.customFieldDefinition.findFirst({
      where: { id: input.definitionId, workspaceId },
    });
    if (!definition) {
      throw new NotFoundException({
        title: 'Definition not found',
        status: 404,
      });
    }
    if (!isGenericValueScope(definition.scope)) throw scopedElsewhere(definition.scope);
    await this.assertMayWriteEntity(scope, ability, workspaceId, definition, input.entityId);
    await this.assertValueAllowed(definition, workspaceId, input.value);
    return this.upsertValue(definition.id, input.entityId, input.value);
  }

  async clearValue(scope: UserScope, ability: AppAbility, id: string): Promise<void> {
    const workspaceId = this.requireWorkspace(scope);
    const row = await this.prisma.client.customFieldValue.findFirst({
      where: { id, definition: { workspaceId } },
      select: {
        id: true,
        entityId: true,
        definition: { select: { scope: true, projectId: true } },
      },
    });
    const notFound = () => new NotFoundException({ title: 'Value not found', status: 404 });
    if (!row) throw notFound();
    if (!isGenericValueScope(row.definition.scope)) throw scopedElsewhere(row.definition.scope);
    // Same gate as setting it: a value on a record the caller cannot see is
    // "not found" (its existence stays hidden), one they cannot edit is 403.
    await this.assertMayWriteEntity(
      scope,
      ability,
      workspaceId,
      row.definition,
      row.entityId,
      notFound,
    );
    await this.prisma.client.customFieldValue.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Client values (/clients/:clientId/custom-fields)
  // -------------------------------------------------------------------------

  /** Values of the workspace's CLIENT fields on one client the actor may read. */
  async listClientValues(actor: SalesActor, clientId: string): Promise<ClientCustomFieldValueList> {
    const client = await requireVisibleClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({ where, select: { id: true, workspaceId: true } }),
    );
    const rows = await this.prisma.client.customFieldValue.findMany({
      where: {
        entityId: client.id,
        definition: { workspaceId: client.workspaceId, scope: 'CLIENT' },
      },
      orderBy: { createdAt: 'asc' },
    });
    return clientCustomFieldValueListSchema.parse({ items: rows });
  }

  /** Set one CLIENT field on a client the actor may change. Null clears it. */
  async setClientValue(
    actor: SalesActor,
    clientId: string,
    definitionId: string,
    input: SetClientCustomFieldInput,
  ): Promise<CustomFieldValue> {
    const client = await requireWritableClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({ where, select: { id: true, workspaceId: true } }),
    );
    const definition = await this.clientDefinition(client.workspaceId, definitionId);
    await this.assertValueAllowed(definition, client.workspaceId, input.value);
    return this.upsertValue(definition.id, client.id, input.value);
  }

  async clearClientValue(actor: SalesActor, clientId: string, definitionId: string): Promise<void> {
    const client = await requireWritableClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({ where, select: { id: true, workspaceId: true } }),
    );
    const definition = await this.clientDefinition(client.workspaceId, definitionId);
    await this.prisma.client.customFieldValue.deleteMany({
      where: { definitionId: definition.id, entityId: client.id },
    });
  }

  // -------------------------------------------------------------------------

  /** A CLIENT-scoped definition in this workspace, or 404. */
  private async clientDefinition(workspaceId: string, definitionId: string) {
    const definition = await this.prisma.client.customFieldDefinition.findFirst({
      where: { id: definitionId, workspaceId, scope: 'CLIENT' },
    });
    if (!definition) {
      throw new NotFoundException({ title: 'Definition not found', status: 404 });
    }
    return definition;
  }

  private async upsertValue(
    definitionId: string,
    entityId: string,
    value: SetCustomFieldValueInput['value'],
  ): Promise<CustomFieldValue> {
    // A JSON null has to be written as Prisma.JsonNull.
    const json = value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
    const row = await this.prisma.client.customFieldValue.upsert({
      where: { definitionId_entityId: { definitionId, entityId } },
      create: { definitionId, entityId, value: json },
      update: { value: json },
    });
    return customFieldValueSchema.parse(row);
  }

  /**
   * Type, option and USER checks. A USER value must be a staff account that
   * is a member of the workspace: never a client-portal person, and never an
   * outsider whose name would then render on the record.
   */
  private async assertValueAllowed(
    definition: { type: string; options: Prisma.JsonValue },
    workspaceId: string,
    value: unknown,
  ): Promise<void> {
    const problem = customFieldValueProblem(definition.type, definition.options, value);
    if (problem) {
      throw new BadRequestException({ title: 'Invalid value', status: 400, detail: problem });
    }
    if (definition.type === 'USER' && typeof value === 'string') {
      const member = await orgWorkspaceMembership(this.prisma, value, workspaceId);
      const staff = member
        ? await this.prisma.client.user.findFirst({
            where: { id: value, accountType: 'STAFF', deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!staff) {
        throw new BadRequestException({
          title: 'Invalid value',
          status: 400,
          detail: 'The selected person is not a member of this workspace.',
        });
      }
    }
  }
}

function cannotEditFields(what: 'task' | 'project'): ForbiddenException {
  return new ForbiddenException({
    title: 'Forbidden',
    status: 403,
    detail: `You can't edit fields on this ${what}.`,
    code: 'insufficient_permissions',
  });
}

function scopedElsewhere(scope: string): BadRequestException {
  return new BadRequestException({
    title: 'Use the record page',
    status: 400,
    detail: `${scope} field values are set from the ${scope.toLowerCase()} page.`,
    code: 'custom-field-scope-route',
  });
}
