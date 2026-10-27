import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  CreateCommentInput,
  ListCommentsQuery,
  UpdateCommentInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { NotificationsService } from '../notifications/notifications.service';
import { generalFileVisibility } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';

const COMMENT_INCLUDE = {
  author: { select: { id: true, name: true, email: true, image: true } },
  attachments: { include: { file: true } },
} as const;

type CommentWithRelations = Prisma.CommentGetPayload<{ include: typeof COMMENT_INCLUDE }>;

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Reachability + `Project.visibility`, both resolved by the shared helper.
   *  See ../common/project-access for why this isn't inlined per service. */
  private projectAccessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  /** Validates that the user can read the task. Returns the workspace id so the
   * caller can verify any referenced attachments belong to the same tenant. */
  private async resolveTaskWorkspace(scope: UserScope, taskId: string): Promise<string> {
    const task = await this.prisma.client.task.findFirst({
      where: { id: taskId, project: this.projectAccessFilter(scope) },
      select: { project: { select: { workspaceId: true } } },
    });
    if (!task) {
      throw new NotFoundException({ title: 'Task not found', status: 404 });
    }
    return task.project.workspaceId;
  }

  async list(scope: UserScope, taskId: string, q: ListCommentsQuery) {
    await this.resolveTaskWorkspace(scope, taskId);

    // Cursor-based pagination, oldest-first (chat-style display). The cursor is
    // a comment id; we fetch one extra row so we know whether a next page exists
    // without a separate count() round-trip.
    const limit = q.limit;
    const items = await this.prisma.client.comment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: COMMENT_INCLUDE,
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: items.map(toSerialized),
      nextCursor,
    };
  }

  async create(
    scope: UserScope,
    userId: string,
    taskId: string,
    input: CreateCommentInput,
  ) {
    const workspaceId = await this.resolveTaskWorkspace(scope, taskId);

    const fileIds = input.fileObjectIds ?? [];
    if (fileIds.length > 0) {
      // Every attachment must belong to the same workspace as the task. Files
      // are workspace-scoped (workspaceId on FileObject) so cross-tenant
      // references are a leak vector - block them at write time.
      const owned = await this.prisma.client.fileObject.findMany({
        where: { id: { in: fileIds }, workspaceId, ...generalFileVisibility(false) },
        select: { id: true },
      });
      if (owned.length !== fileIds.length) {
        throw new ForbiddenException({
          title: 'Forbidden attachment',
          status: 403,
          detail: 'One or more attachments do not belong to this workspace.',
        });
      }
    }

    const created = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.comment.create({
        data: {
          taskId,
          authorId: userId,
          content: input.content as Prisma.InputJsonValue,
          contentText: input.contentText,
        },
      });
      if (fileIds.length > 0) {
        await tx.commentAttachment.createMany({
          data: fileIds.map((fileObjectId) => ({ commentId: row.id, fileObjectId })),
        });
      }
      return tx.comment.findUniqueOrThrow({
        where: { id: row.id },
        include: COMMENT_INCLUDE,
      });
    });

    // Fan out an in-app notification to the task assignee (and the creator, if
    // different from both author and assignee). Failures here MUST NOT roll
    // back the comment write, so we catch and log without rethrowing.
    void this.notifyOnComment(taskId, userId, created.id, fileIds.length).catch((err) => {
      this.logger.warn(
        `Comment notification fan-out failed commentId=${created.id} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    });

    return toSerialized(created);
  }

  /** Builds the recipient list for a new comment and emits one Notification per
   *  recipient. Author is always excluded so people don't get pinged about
   *  their own comments. */
  private async notifyOnComment(
    taskId: string,
    authorId: string,
    commentId: string,
    attachmentCount: number,
  ): Promise<void> {
    const task = await this.prisma.client.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        assigneeId: true,
        createdById: true,
        projectId: true,
      },
    });
    if (!task) return;

    const author = await this.prisma.client.user.findUnique({
      where: { id: authorId },
      select: { name: true, email: true },
    });
    const actorName = author?.name?.trim() || author?.email || 'A teammate';

    const recipients = new Set<string>();
    if (task.assigneeId && task.assigneeId !== authorId) recipients.add(task.assigneeId);
    if (task.createdById && task.createdById !== authorId) recipients.add(task.createdById);
    if (recipients.size === 0) return;

    const truncatedTitle =
      task.title.length > 60 ? `${task.title.slice(0, 60).trim()}...` : task.title;
    // Clean prose, no em-dashes, no exclamation marks.
    const title = `${actorName} commented on ${truncatedTitle}`;
    const body =
      attachmentCount > 0
        ? `${actorName} posted a comment with ${attachmentCount === 1 ? 'an image' : `${attachmentCount} images`} on the task "${truncatedTitle}".`
        : `${actorName} posted a comment on the task "${truncatedTitle}".`;

    await Promise.all(
      [...recipients].map((userId) =>
        this.notifications.emit({
          userId,
          actorId: authorId,
          type: 'TASK_COMMENT',
          title,
          body,
          taskId,
          commentId,
          // Tag the task so opening it clears comment notifications too,
          // and give the OS banner a deep link to the project board.
          entityType: 'task',
          entityId: taskId,
          url: `/projects/${task.projectId}`,
        }),
      ),
    );
  }

  async update(
    scope: UserScope,
    userId: string,
    commentId: string,
    input: UpdateCommentInput,
  ) {
    const existing = await this.prisma.client.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, taskId: true },
    });
    if (!existing) throw new NotFoundException({ title: 'Comment not found', status: 404 });
    // Permission-gate on the parent task - author-only edits, but the task
    // access check is the cheap-rejects layer.
    const workspaceId = await this.resolveTaskWorkspace(scope, existing.taskId);
    if (existing.authorId !== userId) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the comment author can edit.',
      });
    }

    const fileIds = input.fileObjectIds ?? [];
    if (fileIds.length > 0) {
      const owned = await this.prisma.client.fileObject.findMany({
        where: { id: { in: fileIds }, workspaceId, ...generalFileVisibility(false) },
        select: { id: true },
      });
      if (owned.length !== fileIds.length) {
        throw new ForbiddenException({
          title: 'Forbidden attachment',
          status: 403,
          detail: 'One or more attachments do not belong to this workspace.',
        });
      }
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: commentId },
        data: {
          content: input.content as Prisma.InputJsonValue,
          contentText: input.contentText,
          editedAt: new Date(),
        },
      });
      // Replace the attachment set atomically. CommentAttachment is just a
      // join row (no business state beyond createdAt) so wiping and re-creating
      // is simpler than a diff and produces the same outcome for the user.
      await tx.commentAttachment.deleteMany({ where: { commentId } });
      if (fileIds.length > 0) {
        await tx.commentAttachment.createMany({
          data: fileIds.map((fileObjectId) => ({ commentId, fileObjectId })),
        });
      }
      return tx.comment.findUniqueOrThrow({
        where: { id: commentId },
        include: COMMENT_INCLUDE,
      });
    });

    return toSerialized(updated);
  }

  async remove(
    scope: UserScope,
    userId: string,
    workspaceMemberships: ReadonlyArray<{ workspaceId: string; role: string }>,
    commentId: string,
  ) {
    const existing = await this.prisma.client.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, taskId: true },
    });
    if (!existing) throw new NotFoundException({ title: 'Comment not found', status: 404 });

    const workspaceId = await this.resolveTaskWorkspace(scope, existing.taskId);
    const role = workspaceMemberships.find((m) => m.workspaceId === workspaceId)?.role;
    const isAdmin = role === 'OWNER' || role === 'ADMIN';
    if (existing.authorId !== userId && !isAdmin) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the comment author or a workspace admin can delete this comment.',
      });
    }

    // Soft-delete via the extension's interceptor.
    await this.prisma.client.comment.delete({ where: { id: commentId } });
  }
}

/** Project the Prisma row to the shape the shared schema expects (BigInt → string
 *  on FileObject.sizeBytes, attachment shape flattened). */
function toSerialized(row: CommentWithRelations) {
  return {
    ...row,
    attachments: row.attachments.map((a) => ({
      id: a.id,
      fileObjectId: a.fileObjectId,
      createdAt: a.createdAt,
      file: {
        ...a.file,
        sizeBytes: a.file.sizeBytes.toString(),
      },
    })),
  };
}
