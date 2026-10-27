import {
  WORKSPACE_PRESETS,
  canAssignWorkspacePermissions,
  workspacePresetFor,
} from '@botss/auth';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CreateWorkspaceInput,
  InviteMemberInput,
  InviteMemberResponse,
  ListWorkspacesQuery,
  UpdateMembershipInput,
  UpdateWorkspaceInput,
  WorkspaceMembershipWithUser,
} from '@botss/shared-types';

import { assertNotClientAccount } from '../common/client-accounts';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { EmailService } from '../email/email.service';
import {
  invitationIdentifier,
  issueWorkspaceInvitation,
  parseInvitationIdentifier,
} from '../invitations/invitation-tokens';
import { orgWorkspaceMembership, userOrgId } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';
import {
  loadEffectivePermissions,
  userHasCompanyPermission,
} from '../common/permissions/effective-permissions';

type RawMembershipWithUser = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMembershipWithUser['role'];
  invitedById: string | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  customRoleId?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    emailVerified: boolean;
    systemRole?: string;
    customRole?: { name: string; deletedAt: Date | null } | null;
    accounts: { id: string }[];
  };
};

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly audit: AuditLogService,
    @Optional() private readonly alerts?: SecurityAlertsService,
  ) {}

  async listForUser(userId: string, query: ListWorkspacesQuery) {
    // Workspace visibility requires an explicit WorkspaceMembership row.
    // Even admins see only the workspaces they were actually invited to
    // from this endpoint - cross-workspace admin views live on dedicated
    // admin endpoints with their own role checks, not by widening this
    // default fetch.
    // Own organization only: a leftover membership into another org (a user
    // moved between orgs) must not list that org's workspace.
    const orgId = await userOrgId(this.prisma, userId);
    const where = {
      organizationId: orgId ?? '__none__',
      memberships: { some: { userId } },
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { slug: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.workspace.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.client.workspace.count({ where }),
    ]);
    return paginated(items, total, query);
  }

  /**
   * Look up a workspace the user has read access to. Read access = membership
   * in the workspace OR a project membership inside it. Surfacing other
   * workspaces would leak names/slugs across tenants.
   */
  async getByIdScoped(scope: UserScope, workspaceId: string) {
    const accessibleWorkspaceIds = new Set<string>([
      ...scope.workspaceIds,
      // Membership in a project transitively grants read on the surrounding
      // workspace's basic metadata (name, slug). Without this an outside
      // collaborator can't render a project header.
      ...(await this.workspaceIdsFromProjectMemberships(scope.projectIds)),
    ]);
    if (!accessibleWorkspaceIds.has(workspaceId)) {
      throw new NotFoundException({ title: 'Workspace not found', status: 404 });
    }
    return this.getById(workspaceId);
  }

  /** Internal use only - does not enforce scope. */
  async getById(workspaceId: string) {
    const ws = await this.prisma.client.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException({ title: 'Workspace not found', status: 404 });
    return ws;
  }

  async create(userId: string, input: CreateWorkspaceInput) {
    // Anchor the workspace to the creator's organisation so it lives inside
    // the right tenant. Without this, new workspaces are created with
    // organizationId = NULL and fall outside any per-org admin view - and a
    // user could invite members from a different org into an orphan
    // workspace, collapsing the tenant boundary.
    const creator = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    // An org-less user must not create a workspace inside the root org.
    const creatorOrgId = creator?.organizationId;
    if (!creatorOrgId) {
      throw new ForbiddenException({
        title: 'Cannot determine your organization',
        status: 403,
      });
    }
    const ws = await this.prisma.client.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        ownerId: userId,
        // Anchor to the creator's organisation (checked non-null above).
        organizationId: creatorOrgId,
        memberships: { create: { userId, role: 'OWNER' } },
      },
    });
    return ws;
  }

  async update(scope: UserScope, workspaceId: string, input: UpdateWorkspaceInput) {
    // `scope.workspaceIds` is membership-derived, so an org admin who never
    // joined this workspace would be refused here before the role gate below
    // ever ran. The `&&` short-circuits for ordinary members, so the extra
    // lookup only happens on the path that would otherwise 403.
    if (
      !scope.workspaceIds.includes(workspaceId) &&
      !(await this.isOrgAdminFor(workspaceId, scope.userId))
    ) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this workspace.',
      });
    }
    // Only the OWNER or an ADMIN may mutate the workspace's metadata
    // (name, description, etc.). Regular MEMBER / VIEWER / CLIENT roles
    // can read the workspace but not rename it. The CASL ability check
    // upstream gates "is a member at all"; the role gate lives here so
    // the rule is authoritative regardless of which controller dispatches.
    if (!(await this.actorHas(workspaceId, scope.userId, 'workspace.settings'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can edit the workspace',
        status: 403,
      });
    }
    await this.getById(workspaceId);
    // Whitelist fields explicitly so future widening of UpdateWorkspaceInput
    // does not silently expose foreign keys (organizationId, ownerId) or
    // soft-delete timestamps to the mass-assignment surface.
    return this.prisma.client.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      },
    });
  }

  async remove(scope: UserScope, userId: string, workspaceId: string) {
    // See `update` - membership-derived scope would refuse an org admin who
    // isn't a member of the workspace they administer.
    if (
      !scope.workspaceIds.includes(workspaceId) &&
      !(await this.isOrgAdminFor(workspaceId, userId))
    ) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this workspace.',
      });
    }
    // Deleting a workspace stays the owner's call - a workspace ADMIN with
    // broad CASL rights should not be able to nuke it. Organization admins
    // resolve to OWNER via `getActorRoleOrThrow`, so they pass: deleting a
    // workspace inside their own tenant is squarely their remit.
    const actorRole = await this.getActorRoleOrThrow(workspaceId, userId);
    if (actorRole !== 'OWNER') {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an organization admin can delete the workspace',
        status: 403,
      });
    }
    await this.getById(workspaceId);
    await this.prisma.client.workspace.delete({ where: { id: workspaceId } });
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMembershipWithUser[]> {
    const rows = (await this.prisma.client.workspaceMembership.findMany({
      where: { workspaceId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
            systemRole: true,
            customRole: { select: { name: true, deletedAt: true } },
            accounts: {
              where: { providerId: 'credential' },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    })) as unknown as RawMembershipWithUser[];

    return rows.map((m) => toMembershipWithUser(m));
  }

  /** Members of the workspace that owns a given project, when the caller is
   * authorized to view the project. Used by assignee pickers on the project
   * detail page so an outside collaborator can still pick from the right pool. */
  async listMembersForProject(scope: UserScope, projectId: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...projectAccessWhere(scope) },
      select: { workspaceId: true },
    });
    if (!project) throw new NotFoundException({ title: 'Project not found', status: 404 });
    return this.listMembers(project.workspaceId);
  }

  /**
   * Invite by email. Always materialises a User + WorkspaceMembership so the
   * invitee shows up in the members table immediately (pending until they
   * accept). A VerificationToken row stashes the secure random token used by
   * the public accept flow. The email send is enqueued via the BullMQ email
   * queue; the invitation URL is also returned in the response so admins can
   * copy-paste the link if the recipient cannot find the email.
   */
  async inviteMember(
    workspaceId: string,
    invitedById: string,
    input: InviteMemberInput,
  ): Promise<InviteMemberResponse> {
    // Inviting is a role change in disguise - only OWNER/ADMIN may grow the
    // workspace. MEMBER cannot pull in new peers.
    if (!(await this.actorHas(workspaceId, invitedById, 'members.manage'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can invite members',
        status: 403,
      });
    }
    // Default from the invitee's company role: org admins join as ADMIN.
    const inviteeRole = (
      await this.prisma.client.user.findUnique({
        where: { email: input.email.trim().toLowerCase() },
        select: { systemRole: true },
      })
    )?.systemRole;
    const inviteRole =
      input.role ?? (inviteeRole === 'ADMIN' || inviteeRole === 'SUPER_ADMIN' ? 'ADMIN' : 'MEMBER');
    await this.assertCanGrantPreset(workspaceId, invitedById, inviteRole);
    // Admins may invite at any non-owner rank, including ADMIN - same trust
    // level `updateMemberRole` already grants them. Gating it here bought
    // nothing: an admin could invite as MEMBER and promote to ADMIN in the
    // next request, so the restriction was friction, not a boundary. OWNER
    // stays unassignable via `InviteMemberInput` (role excludes OWNER).
    const email = input.email.trim().toLowerCase();

    // Look up user + their workspace membership in one round-trip per object.
    const existingUser = await this.prisma.client.user.findUnique({ where: { email } });

    if (existingUser) {
      // A client-portal account has no org, so the cross-org check below
      // would wave it through and make it a workspace member - putting a
      // client into assignee, mention and share pickers. Refuse outright.
      assertNotClientAccount(existingUser.accountType);
      const dup = await this.prisma.client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
      });
      if (dup) {
        throw new ConflictException({
          title: 'Already a member',
          status: 409,
          detail: 'This user is already a member of the workspace.',
        });
      }
    }

    const workspace = await this.getById(workspaceId);

    // Tenant boundary: never let an existing user from one org be invited
    // into another org's workspace. The invite path is the canonical place
    // where a cross-org WorkspaceMembership could be created - block it
    // here authoritatively. New users (existingUser === null) inherit the
    // workspace's org via the User creation below, so they're fine.
    if (existingUser && existingUser.organizationId && existingUser.organizationId !== workspace.organizationId) {
      throw new ForbiddenException({
        title: 'Invitee belongs to another organization',
        status: 403,
        detail:
          'This email is already attached to a different organization. Cross-organization workspace membership is not allowed.',
      });
    }

    // Create the User if missing. We always end up with both a User row and a
    // WorkspaceMembership row - `pending` is derived from emailVerified + the
    // absence of a credential Account.
    const user =
      existingUser ??
      (await this.prisma.client.user.create({
        data: {
          email,
          name: input.name?.trim() || email.split('@')[0] || email,
          emailVerified: false,
          timezone: 'Asia/Karachi',
          locale: 'en',
          // Pin the new user to the workspace's org so the auto-route
          // service can't subsequently move them somewhere else based on
          // an email-domain match - keeps the tenant boundary explicit.
          organizationId: workspace.organizationId,
        },
      }));

    const membership = await this.prisma.client.workspaceMembership.create({
      data: { workspaceId, userId: user.id, role: inviteRole, invitedById },
    });

    // If the invitee already has a credential Account (existing user being
    // added to a new workspace), they don't need to set a password - return
    // a null invitation URL and skip token creation.
    const hasCredential = await this.prisma.client.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
      select: { id: true },
    });

    let invitationUrl: string | null = null;
    let invitationCode: string | null = null;
    if (!hasCredential) {
      const issued = await this.issueInvitationToken({ workspaceId, userId: user.id });
      invitationUrl = issued.url;
      invitationCode = issued.code;
    }

    const wasNewUser = !existingUser;

    this.logger.log(
      `[INVITE] workspace=${workspace.name} (${workspaceId}) email=${email} role=${inviteRole} ` +
        `wasNewUser=${wasNewUser} hasUrl=${invitationUrl !== null}`,
    );
    if (inviteRole === 'ADMIN') {
      void this.alerts?.recordNewAdmin({
        organizationId: workspace.organizationId,
        actorUserId: invitedById,
        userId: user.id,
        scope: 'workspace',
        role: inviteRole,
      });
    }
    if (invitationUrl && invitationCode) {
      const inviter = await this.prisma.client.user.findUnique({
        where: { id: invitedById },
        select: { name: true },
      });
      await this.email.sendWorkspaceInvitation({
        to: email,
        recipientName: user.name,
        workspaceName: workspace.name,
        inviterName: inviter?.name ?? null,
        url: invitationUrl,
        code: invitationCode,
        // Tenant routing: pass the workspace's organizationId so the
        // BullMQ processor can pick the tenant's OrganizationMailConfig
        // before falling back to the platform env transport. Without
        // this hint invites silently never delivered for tenants that
        // configured their own SMTP - the symptom reported.
        organizationId: workspace.organizationId,
      });
    }

    return {
      membership: toMembershipWithUser({
        ...membership,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          emailVerified: user.emailVerified,
          accounts: hasCredential ? [{ id: hasCredential.id }] : [],
        },
      }),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      },
      invitationUrl,
      invitationCode,
      wasNewUser,
    };
  }

  /**
   * Regenerate the invitation token for a pending membership and return a
   * fresh URL. No-op if the membership is no longer pending (user already
   * accepted or already had a credential).
   */
  async resendInvitation(
    workspaceId: string,
    actingUserId: string,
    membershipId: string,
  ): Promise<InviteMemberResponse> {
    // Same gate as `inviteMember` - regenerating a token mints a fresh, live
    // credential for joining the workspace, so it needs the invite-level role,
    // not just the broad CASL `manage WorkspaceMembership` grant every member
    // carries in Phase 1.
    if (!(await this.actorHas(workspaceId, actingUserId, 'members.manage'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can resend invitations',
        status: 403,
      });
    }
    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { id: membershipId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
            systemRole: true,
            customRole: { select: { name: true, deletedAt: true } },
            accounts: {
              where: { providerId: 'credential' },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!membership || membership.workspaceId !== workspaceId) {
      throw new NotFoundException({ title: 'Membership not found', status: 404 });
    }
    if (membership.user.accounts.length > 0 && membership.user.emailVerified) {
      throw new BadRequestException({
        title: 'Not pending',
        status: 400,
        detail: 'This member has already accepted the invitation.',
      });
    }

    const { url: invitationUrl, code: invitationCode } = await this.issueInvitationToken({
      workspaceId,
      userId: membership.userId,
    });

    const workspace = await this.getById(workspaceId);
    await this.email.sendWorkspaceInvitation({
      to: membership.user.email,
      recipientName: membership.user.name,
      workspaceName: workspace.name,
      inviterName: null,
      url: invitationUrl,
      code: invitationCode,
      organizationId: workspace.organizationId,
    });

    return {
      membership: toMembershipWithUser(membership as unknown as RawMembershipWithUser),
      user: {
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        image: membership.user.image,
      },
      invitationUrl,
      invitationCode,
      wasNewUser: false,
    };
  }

  /**
   * Revoke a pending invitation: delete the membership and any outstanding
   * token. Active (accepted) memberships use `removeMember` instead.
   */
  async revokeInvitation(
    workspaceId: string,
    actingUserId: string,
    membershipId: string,
  ): Promise<void> {
    // Revoking deletes a membership row, so it needs the same role as
    // `removeMember`. Without this a plain MEMBER could evict any pending
    // invitee, since the upstream CASL gate gives every member `manage all`.
    if (!(await this.actorHas(workspaceId, actingUserId, 'members.manage'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can revoke invitations',
        status: 403,
      });
    }
    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { id: membershipId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!membership || membership.workspaceId !== workspaceId) {
      throw new NotFoundException({ title: 'Invitation not found', status: 404 });
    }
    if (membership.role === 'OWNER') {
      throw new BadRequestException({
        title: 'Cannot revoke owner',
        status: 400,
        detail: 'The workspace owner cannot be revoked.',
      });
    }

    await this.prisma.client.$transaction([
      this.prisma.client.verificationToken.deleteMany({
        where: { identifier: invitationIdentifier(workspaceId, membership.userId) },
      }),
      this.prisma.client.workspaceMembership.delete({ where: { id: membershipId } }),
    ]);
  }

  async updateMemberRole(
    workspaceId: string,
    actingUserId: string,
    membershipId: string,
    input: UpdateMembershipInput,
  ): Promise<WorkspaceMembershipWithUser> {
    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { id: membershipId },
    });
    if (!membership || membership.workspaceId !== workspaceId) {
      throw new NotFoundException({ title: 'Membership not found', status: 404 });
    }
    if (membership.userId === actingUserId) {
      throw new BadRequestException({
        title: 'Cannot change your own role',
        status: 400,
        detail: 'Ask another admin or the workspace owner to change your role.',
      });
    }
    if (membership.role === 'OWNER') {
      throw new BadRequestException({
        title: 'Cannot change owner',
        status: 400,
        detail: 'The workspace owner role cannot be changed from this surface.',
      });
    }
    if (input.role === 'OWNER') {
      throw new BadRequestException({
        title: 'Cannot assign owner role',
        status: 400,
        detail: 'Ownership transfer is not supported from this surface.',
      });
    }
    // Role changes are restricted to OWNER and ADMIN. A regular MEMBER (or
    // any lower-tier role) cannot reshuffle peers - the CASL ability gate
    // upstream considers all members able to read the workspace, so without
    // this guard a MEMBER could demote another MEMBER to VIEWER. Authoritative
    // server check; the UI mirrors the same rule.
    if (!(await this.actorHas(workspaceId, actingUserId, 'members.manage'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can change member roles',
        status: 403,
      });
    }
    // Admins are trusted peers: they may change any non-owner member's role,
    // including promoting members to ADMIN and adjusting another admin's rank.
    // The OWNER role stays protected by the `membership.role === 'OWNER'` and
    // `input.role === 'OWNER'` guards above, so an admin still cannot remove or
    // mint an owner.
    if (input.customRoleId === undefined || input.customRoleId === null) {
      await this.assertCanGrantPreset(workspaceId, actingUserId, input.role);
    }
    // Custom workspace role: must be a live WORKSPACE role of this org, and a
    // non-company-admin may only hand out permissions they hold themselves.
    let customRoleId: string | null | undefined = undefined;
    if (input.customRoleId !== undefined) {
      customRoleId = input.customRoleId;
      if (customRoleId) {
        const ws = await this.prisma.client.workspace.findUnique({
          where: { id: workspaceId },
          select: { organizationId: true },
        });
        const role = await this.prisma.client.role.findFirst({
          where: { id: customRoleId, scope: 'WORKSPACE', organizationId: ws?.organizationId ?? '__none__' },
          select: { permissions: true },
        });
        if (!role) {
          throw new BadRequestException({ title: 'Unknown workspace role', status: 400 });
        }
        if (!(await this.isOrgAdminFor(workspaceId, actingUserId))) {
          const actorEff = await loadEffectivePermissions(actingUserId, workspaceId);
          const verdict = canAssignWorkspacePermissions(actorEff, role.permissions);
          if (!verdict.ok) {
            throw new ForbiddenException({ title: 'Cannot assign this role', status: 403, detail: verdict.reason });
          }
        }
      }
    }
    const updated = (await this.prisma.client.workspaceMembership.update({
      where: { id: membershipId },
      data: {
        role: input.role,
        ...(customRoleId !== undefined ? { customRoleId } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
            systemRole: true,
            customRole: { select: { name: true, deletedAt: true } },
            accounts: {
              where: { providerId: 'credential' },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    })) as unknown as RawMembershipWithUser;
    const orgId = (
      await this.prisma.client.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      })
    )?.organizationId;
    if (orgId) {
      void this.audit.emit({
        organizationId: orgId,
        actorUserId: actingUserId,
        action: 'workspace.member.role_change',
        target: `user:${membership.userId}`,
        metadata: {
          workspaceId,
          from: { role: membership.role, customRoleId: membership.customRoleId },
          to: { role: input.role, customRoleId: customRoleId === undefined ? membership.customRoleId : customRoleId },
        },
      });
      if (input.role === 'ADMIN' && membership.role !== input.role) {
        void this.alerts?.recordNewAdmin({
          organizationId: orgId,
          actorUserId: actingUserId,
          userId: membership.userId,
          scope: 'workspace',
          role: input.role,
        });
      }
    }
    return toMembershipWithUser(updated);
  }

  async removeMember(
    workspaceId: string,
    actingUserId: string,
    membershipId: string,
  ): Promise<void> {
    const membership = await this.prisma.client.workspaceMembership.findUnique({
      where: { id: membershipId },
    });
    if (!membership || membership.workspaceId !== workspaceId) {
      throw new NotFoundException({ title: 'Membership not found', status: 404 });
    }
    if (membership.userId === actingUserId) {
      throw new BadRequestException({
        title: 'Cannot remove yourself',
        status: 400,
        detail: 'Ask another admin or the workspace owner to remove you from this workspace.',
      });
    }
    if (membership.role === 'OWNER') {
      throw new BadRequestException({
        title: 'Cannot remove owner',
        status: 400,
        detail: 'The workspace owner cannot be removed.',
      });
    }
    // Only OWNER/ADMIN can remove anybody. MEMBER and below have no business
    // evicting peers - the CASL gate ranks "manage WorkspaceMembership" broadly
    // so this is the authoritative role check.
    if (!(await this.actorHas(workspaceId, actingUserId, 'members.manage'))) {
      throw new ForbiddenException({
        title: 'Only the workspace owner or an admin can remove members',
        status: 403,
      });
    }
    // Admins may remove peer admins. This mirrors the invite side: an admin
    // can mint another admin, so blocking removal would let them create peers
    // they cannot undo. The owner stays protected by the `membership.role ===
    // 'OWNER'` guard above, and nobody can remove themselves.
    await this.prisma.client.workspaceMembership.delete({ where: { id: membershipId } });
  }

  /**
   * Whether `userId` administers `workspaceId`: its OWNER or ADMIN, or an org
   * admin of the owning organization (reported as OWNER below). The same rule
   * that gates member invites, exposed for gates outside this service - the
   * client portal (who may give a client's people access, and what a client
   * sees of a project).
   */
  async canAdminister(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const role = await this.getActorRoleOrThrow(workspaceId, userId);
      return role === 'OWNER' || role === 'ADMIN';
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  }

  /**
   * Resolve the acting user's effective WorkspaceMembership role. Throws 403
   * when the caller isn't a member of the workspace at all - should never
   * happen given `RequireAbility` runs first, but defends against guard
   * misconfiguration.
   *
   * Organization admins are reported as OWNER: they administer every workspace
   * in their own tenant, so they clear all per-workspace role gates. Reporting
   * the elevated role here (rather than adding an org-admin branch to each
   * caller) means every gate honours it uniformly - including the owner-only
   * `remove`. The owner-row invariants that callers enforce against the
   * *target* membership (cannot remove or re-rank the OWNER) are unaffected.
   */
  /**
   * Whether the actor holds a workspace permission in `workspaceId` (custom
   * roles and overrides included). Org admins of the owning org always do.
   */
  private async actorHas(workspaceId: string, userId: string, permission: string): Promise<boolean> {
    if (await this.isOrgAdminFor(workspaceId, userId)) return true;
    const eff = await loadEffectivePermissions(userId, workspaceId);
    return eff.workspace.includes(permission);
  }

  /**
   * A workspace manager may only hand out a preset whose permissions they
   * hold themselves (an OWNER / ADMIN holds them all). Org admins may give any.
   */
  private async assertCanGrantPreset(workspaceId: string, actorId: string, role: string): Promise<void> {
    if (await this.isOrgAdminFor(workspaceId, actorId)) return;
    const actorEff = await loadEffectivePermissions(actorId, workspaceId);
    const verdict = canAssignWorkspacePermissions(
      actorEff,
      WORKSPACE_PRESETS[workspacePresetFor(role)],
    );
    if (!verdict.ok) {
      throw new ForbiddenException({ title: 'Cannot assign this role', status: 403, detail: verdict.reason });
    }
  }

  private async getActorRoleOrThrow(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipWithUser['role']> {
    const actor = await orgWorkspaceMembership(this.prisma, userId, workspaceId);
    // Already the top per-workspace rank - no need to pay for the org lookup.
    if (actor?.role === 'OWNER') return actor.role;
    if (await this.isOrgAdminFor(workspaceId, userId)) return 'OWNER';
    if (!actor) {
      throw new ForbiddenException({
        title: 'Not a member of this workspace',
        status: 403,
      });
    }
    return actor.role;
  }

  /**
   * Whether `userId` administers the organization that owns `workspaceId`.
   *
   * The same-organization comparison is the security boundary here: a system
   * ADMIN of org A must never reach org B's workspaces. A workspace with no
   * `organizationId` (the personal bootstrap workspaces every user gets) has
   * no org admin by definition, so a null on either side denies.
   *
   * SUPER_ADMIN gets no exception: it holds `workspaces.admin_all`, so it
   * administers every workspace of its own (root) organization and none of
   * any other. Tenants are managed through the organizations module only.
   */
  private async isOrgAdminFor(workspaceId: string, userId: string): Promise<boolean> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    if (!user) return false;
    // Company `workspaces.admin_all` (ADMIN preset, or a custom role).
    if (!(await userHasCompanyPermission(userId, 'workspaces.admin_all'))) return false;
    if (!user.organizationId) return false;
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    return !!workspace && workspace.organizationId === user.organizationId;
  }

  /**
   * Mint a fresh link + code for an invitee. Any outstanding tokens for the
   * same (workspace, user) pair are cleared first so old links stop working.
   */
  private async issueInvitationToken(args: {
    workspaceId: string;
    userId: string;
  }): Promise<{ url: string; code: string }> {
    const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    return issueWorkspaceInvitation(this.prisma, appUrl, args);
  }

  private async workspaceIdsFromProjectMemberships(projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.prisma.client.project.findMany({
      where: { id: { in: projectIds } },
      select: { workspaceId: true },
    });
    return rows.map((r) => r.workspaceId);
  }
}

export { invitationIdentifier, parseInvitationIdentifier };

/** The member's company role for display: custom role name, else the preset. */
function companyRoleLabel(u: RawMembershipWithUser['user']): string | null {
  if (u.customRole && u.customRole.deletedAt === null) return u.customRole.name;
  return u.systemRole ?? null;
}

function toMembershipWithUser(m: RawMembershipWithUser): WorkspaceMembershipWithUser {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    userId: m.userId,
    role: m.role,
    invitedById: m.invitedById,
    customRoleId: m.customRoleId ?? null,
    companyRole: companyRoleLabel(m.user),
    joinedAt: m.joinedAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    user: {
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
    },
    pending: m.user.accounts.length === 0 && !m.user.emailVerified,
  };
}

function paginated<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return {
    items,
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize) || 1,
    },
  };
}
