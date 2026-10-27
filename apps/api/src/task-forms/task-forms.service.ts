import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateTaskFormInput,
  PublicTaskForm,
  SubmitTaskFormInput,
  TaskFormField,
  UpdateTaskFormInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class TaskFormsService {
  private readonly logger = new Logger(TaskFormsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Reachability + `Project.visibility`, both resolved by the shared helper.
   *  See ../common/project-access for why this isn't inlined per service. */
  private projectAccessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  /**
   * Every submission creates a task assigned to this person, so the same rule
   * as a task assignee applies: a team member in the project's org, never
   * another tenant's user or a client-portal account.
   */
  private async assertAssigneeInOrg(projectId: string, assigneeId: string): Promise<void> {
    const [project, assignee] = await Promise.all([
      this.prisma.client.project.findUnique({
        where: { id: projectId },
        select: { workspace: { select: { organizationId: true } } },
      }),
      this.prisma.client.user.findUnique({
        where: { id: assigneeId },
        select: { organizationId: true, accountType: true },
      }),
    ]);
    if (
      !project ||
      !assignee ||
      assignee.accountType !== 'STAFF' ||
      assignee.organizationId !== project.workspace.organizationId
    ) {
      throw new BadRequestException({
        title: 'Invalid default assignee',
        status: 400,
        detail: 'The default assignee must be a team member in the same organization.',
      });
    }
  }

  private async assertProjectAccess(scope: UserScope, projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...this.projectAccessFilter(scope) },
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

  async list(scope: UserScope, projectId: string) {
    await this.assertProjectAccess(scope, projectId);
    return this.prisma.client.taskForm.findMany({
      // TaskForm is not in the soft-delete extension, so the filter is manual.
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(scope: UserScope, formId: string) {
    const form = await this.prisma.client.taskForm.findFirst({
      where: { id: formId, deletedAt: null },
    });
    if (!form) throw new NotFoundException({ title: 'Form not found', status: 404 });
    await this.assertProjectAccess(scope, form.projectId);
    return form;
  }

  async create(scope: UserScope, userId: string, projectId: string, input: CreateTaskFormInput) {
    await this.assertProjectAccess(scope, projectId);
    if (input.defaultAssigneeId) {
      await this.assertAssigneeInOrg(projectId, input.defaultAssigneeId);
    }
    return this.prisma.client.taskForm.create({
      data: {
        projectId,
        createdById: userId,
        name: input.name,
        description: input.description ?? null,
        fields: input.fields as unknown as object,
        defaultStatus: input.defaultStatus,
        defaultPriority: input.defaultPriority,
        defaultAssigneeId: input.defaultAssigneeId ?? null,
        isPublic: input.isPublic,
        publicSlug: input.isPublic ? randomBytes(8).toString('hex') : null,
      },
    });
  }

  async update(scope: UserScope, formId: string, input: UpdateTaskFormInput) {
    const form = await this.get(scope, formId);
    if (input.defaultAssigneeId) {
      await this.assertAssigneeInOrg(form.projectId, input.defaultAssigneeId);
    }
    const data: Record<string, unknown> = { ...input };
    // Toggle public slug when isPublic flips.
    if (input.isPublic === true && !form.publicSlug) {
      data['publicSlug'] = randomBytes(8).toString('hex');
    } else if (input.isPublic === false) {
      data['publicSlug'] = null;
    }
    if (input.fields) data['fields'] = input.fields as unknown as object;
    return this.prisma.client.taskForm.update({ where: { id: formId }, data });
  }

  async remove(scope: UserScope, formId: string) {
    await this.get(scope, formId);
    // Soft delete. The schema carries `deletedAt` for this model but it is not
    // in the soft-delete extension, so `.delete()` was a real hard delete that
    // cascaded away every submission. Also retire the public slug so the
    // public link stops resolving.
    await this.prisma.client.taskForm.update({
      where: { id: formId },
      data: { deletedAt: new Date(), isPublic: false, publicSlug: null },
    });
  }

  async submissions(scope: UserScope, formId: string) {
    await this.get(scope, formId);
    return this.prisma.client.taskFormSubmission.findMany({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
  }

  // ── Public (no auth) ──────────────────────────────────────────────────────

  async publicGet(slug: string): Promise<PublicTaskForm> {
    const form = await this.prisma.client.taskForm.findUnique({
      where: { publicSlug: slug },
      include: { project: { select: { name: true, key: true } } },
    });
    if (!form || !form.isPublic || form.deletedAt) {
      throw new NotFoundException({ title: 'Form not found', status: 404 });
    }
    return {
      name: form.name,
      description: form.description,
      fields: form.fields as unknown as TaskFormField[],
      projectName: form.project.name,
      projectKey: form.project.key,
    };
  }

  /**
   * Public submission endpoint. Creates a Task in the parent project using
   * the form's defaults, plus a TaskFormSubmission row carrying the raw
   * payload. Rate-limited per IP: 10 submissions / hour via Redis counter.
   */
  async publicSubmit(args: {
    slug: string;
    input: SubmitTaskFormInput;
    ip: string;
    userAgent: string | null;
  }) {
    const form = await this.prisma.client.taskForm.findUnique({
      where: { publicSlug: args.slug },
    });
    if (!form || !form.isPublic || form.deletedAt) {
      throw new NotFoundException({ title: 'Form not found', status: 404 });
    }

    // Rate limit: 10 / hour / IP. INCR with EXPIRE on first set.
    const key = `taskform:rate:${args.ip}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, 3600);
    }
    if (count > 10) {
      throw new HttpException(
        {
          title: 'Too many submissions',
          status: 429,
          detail: 'Rate limit: 10 submissions per hour. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Validate against the form's own definition. The public payload used to
    // be stored verbatim: unknown keys were kept and `required` was enforced
    // only in the browser, so tasks could be created from empty submissions.
    const fields = form.fields as unknown as TaskFormField[];
    const payload: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      const value = args.input.payload[f.id];
      const empty =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim().length === 0) ||
        (f.type === 'checkbox' && value === false);
      if (f.required && empty) {
        throw new BadRequestException({
          title: 'Missing required field',
          status: 400,
          detail: `"${f.label}" is required.`,
        });
      }
      if (value === undefined) continue;
      if (f.type === 'select' && typeof value === 'string' && f.options && f.options.length > 0) {
        if (!f.options.includes(value)) {
          throw new BadRequestException({
            title: 'Invalid option',
            status: 400,
            detail: `"${f.label}" has an invalid value.`,
          });
        }
      }
      payload[f.id] = value;
    }
    args.input.payload = payload;

    // Compose a task title from the first text-like field, falling back to
    // the form name.
    const titleField = fields.find((f) => f.type === 'text' || f.type === 'textarea');
    const title =
      (titleField && typeof args.input.payload[titleField.id] === 'string'
        ? (args.input.payload[titleField.id] as string)
        : null) ?? `Form submission: ${form.name}`;

    // Build a description from the rest of the fields.
    const descriptionLines = fields
      .filter((f) => f.id !== titleField?.id)
      .map((f) => `**${f.label}**: ${formatValue(args.input.payload[f.id])}`)
      .filter((line) => line.includes(': '));

    return this.prisma.client.$transaction(async (tx) => {
      const last = await tx.task.findFirst({
        where: { projectId: form.projectId, status: form.defaultStatus },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const task = await tx.task.create({
        data: {
          projectId: form.projectId,
          createdById: form.createdById,
          assigneeId: form.defaultAssigneeId,
          title: title.slice(0, 200),
          description: descriptionLines.join('\n\n').slice(0, 4000),
          status: form.defaultStatus,
          priority: form.defaultPriority,
          position: (last?.position ?? -1) + 1,
        },
      });
      await tx.taskFormSubmission.create({
        data: {
          formId: form.id,
          taskId: task.id,
          payload: args.input.payload as unknown as object,
          submittedByEmail: args.input.submittedByEmail ?? null,
          ip: args.ip,
          userAgent: args.userAgent,
        },
      });
      const project = await tx.project.findUniqueOrThrow({
        where: { id: form.projectId },
        select: { key: true },
      });
      return {
        ok: true as const,
        reference: `${project.key}-${task.id.slice(-6).toUpperCase()}`,
      };
    });
  }
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
