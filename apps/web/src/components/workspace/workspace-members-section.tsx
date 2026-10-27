'use client';

import {
  Copy,
  MailCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { WorkspaceMembershipWithUser, WorkspaceRole } from '@botss/shared-types';

import { MemberAccessDialog } from '@/components/roles/member-access-dialog';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useInviteWorkspaceMember,
  useRemoveWorkspaceMember,
  useResendInvitation,
  useRevokeInvitation,
  useUpdateWorkspaceMember,
  useWorkspaceMembers,
} from '@/hooks/use-workspace-members';
import {
  companyRoleLabel,
  customRoleOptions,
  memberRoleUpdate,
  memberRoleValue,
} from '@/hooks/use-member-roles';
import { usePermissions } from '@/hooks/use-permissions';
import { useRoles } from '@/hooks/use-roles';
import { useSession } from '@/lib/auth-client';
import { absoluteTime, relativeTime } from '@/lib/time';
import { getErrorMessage, markErrorReported, toast } from '@/lib/toast';

/** Roles that can be assigned here. CLIENT is gone on purpose: that
 *  workspace role reads workspace-wide and is NOT client access. Client
 *  people are invited from a client's Portal tab. */
type AssignableRole = Exclude<WorkspaceRole, 'OWNER' | 'CLIENT'>;

const ROLE_OPTIONS: { value: AssignableRole; label: string; description: string }[] = [
  { value: 'ADMIN', label: 'Admin', description: 'Manage workspace and members.' },
  { value: 'MEMBER', label: 'Member', description: 'Create and edit shared work.' },
  { value: 'VIEWER', label: 'Viewer', description: 'Read-only access.' },
];

// OWNER and ADMIN can both assign any non-owner role (including ADMIN). The
// OWNER role itself is never an option here. Mirrors the backend guard in
// WorkspacesService.updateMemberRole.
function visibleRoleOptions(actorRole: WorkspaceRole | null) {
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return ROLE_OPTIONS;
  return ROLE_OPTIONS.filter((r) => r.value !== 'ADMIN');
}

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
  // Legacy rows only; no longer assignable (see ROLE_OPTIONS).
  CLIENT: 'Client (legacy)',
  // Phase 4 - finer-grained roles introduced with the org-layer refactor.
  MANAGER: 'Manager',
  EDITOR: 'Editor',
};

const ROLE_TONE: Record<WorkspaceRole, 'brand' | 'info' | 'neutral'> = {
  OWNER: 'brand',
  ADMIN: 'brand',
  MEMBER: 'info',
  VIEWER: 'neutral',
  CLIENT: 'neutral',
  MANAGER: 'brand',
  EDITOR: 'info',
};

/** Invite without a role: the server derives it from the company role. */
const AUTO_ROLE = 'AUTO';

/** The link and its 6-digit code go together: both are needed to accept. */
function copyInvitationToast(url: string, email: string, code?: string | null): void {
  void navigator.clipboard.writeText(code ? `${url}\nCode: ${code}` : url).catch(() => {
    // Clipboard access was denied. The URL is still shown in the toast.
  });
  toast.success(
    `Invitation link${code ? ` and code ${code}` : ''} ready for ${email} (copied to clipboard). Outbound email has been queued.`,
  );
}

export function WorkspaceMembersSection() {
  const members = useWorkspaceMembers();
  const update = useUpdateWorkspaceMember();
  const remove = useRemoveWorkspaceMember();
  const revoke = useRevokeInvitation();
  const resend = useResendInvitation();
  const session = useSession();
  const currentUserId = session.data?.user?.id ?? null;
  // Until the session loads, we can't determine `isSelf` reliably. Hold off
  // rendering modifiable controls so a brief null doesn't expose the role
  // dropdown on the actor's own row (a window in which they could pick a
  // role for themselves before backend rejects it).
  const sessionReady = !session.isPending && currentUserId !== null;
  // Resolve the acting user's role inside this workspace so we can scope the
  // available role options and gate kick controls when the actor is an
  // ADMIN (not OWNER). Falls back to null while data loads.
  const actorRole: WorkspaceRole | null =
    members.data?.find((m) => m.user.id === currentUserId)?.role ?? null;
  // Effective permissions: org admins (`workspaces.admin_all`) administer
  // every workspace in their tenant; otherwise `members.manage` in this
  // workspace (OWNER / ADMIN presets, or a custom role). UX hint only; the
  // server re-checks, including that managers only hand out what they hold.
  const perms = usePermissions();
  const isOrgAdmin = perms.isOrgAdmin;
  const canManage = isOrgAdmin || perms.workspace.includes('members.manage');
  const roles = useRoles(canManage);
  const customOptions = customRoleOptions(roles.data?.workspace);
  // The role pickers key off rank: a full workspace manager sees ADMIN too.
  const effectiveActorRole: WorkspaceRole | null =
    isOrgAdmin || perms.workspace.includes('members.manage') ? 'OWNER' : actorRole;
  const [extrasTarget, setExtrasTarget] = useState<WorkspaceMembershipWithUser | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [search, setSearch] = useState('');
  // The full member list loads at once, so filter client-side by name/email.
  const filteredMembers = useMemo(() => {
    const all = members.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) =>
        (m.user.name ?? '').toLowerCase().includes(q) ||
        m.user.email.toLowerCase().includes(q),
    );
  }, [members.data, search]);

  return (
    <>
      <section
        aria-labelledby="workspace-members-heading"
        className="rounded-lg border border-line bg-white p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="workspace-members-heading" className="text-base font-semibold text-ink">
              Members
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Everyone with access to this workspace. Pending invitees show until they set a password.
            </p>
          </div>
          {canManage ? (
            <Button onClick={() => setInviteOpen(true)} size="sm">
              <UserPlus className="h-4 w-4" />
              Invite member
            </Button>
          ) : null}
        </div>

        {!members.isLoading && members.data && members.data.length > 0 ? (
          <div className="relative mt-4 max-w-sm">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members…"
              aria-label="Search members"
              className="h-9 pl-8"
            />
          </div>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          {members.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : filteredMembers.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Member</th>
                  <th className="px-3 py-2">Workspace role</th>
                  <th className="px-3 py-2">Company role</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Joined</th>
                  {canManage ? (
                    <th className="px-3 py-2 text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    canManage={canManage && sessionReady}
                    actorRole={effectiveActorRole}
                    isSelf={sessionReady && m.user.id === currentUserId}
                    customOptions={customOptions}
                    onChangeRole={(value) =>
                      update.mutate({ id: m.id, input: memberRoleUpdate(value, m.role) })
                    }
                    onExtras={() => setExtrasTarget(m)}
                    onRemove={() =>
                      setRemoveTarget({ id: m.id, name: m.user.name || m.user.email })
                    }
                    onRevoke={() =>
                      setRevokeTarget({ id: m.id, email: m.user.email })
                    }
                    onResend={async () => {
                      try {
                        const result = await resend.mutateAsync(m.id);
                        if (result.invitationUrl) {
                          copyInvitationToast(result.invitationUrl, m.user.email, result.invitationCode);
                        } else {
                          toast.success(`Invitation queued again for delivery to ${m.user.email}.`);
                        }
                      } catch {
                        // hook surfaces the error toast
                      }
                    }}
                    resending={resend.isPending}
                  />
                ))}
              </tbody>
            </table>
          ) : members.isError && !members.data ? (
            <QueryError
              message="Couldn't load members."
              onRetry={() => void members.refetch()}
            />
          ) : (
            <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
              {search.trim() ? 'No members match your search.' : 'No members yet.'}
            </div>
          )}
        </div>
      </section>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} actorRole={effectiveActorRole} />

      <MemberAccessDialog
        member={extrasTarget}
        onOpenChange={(next) => {
          if (!next) setExtrasTarget(null);
        }}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRemoveTarget(null);
        }}
        title="Remove this member?"
        description={
          removeTarget ? `${removeTarget.name} will lose access to this workspace.` : ''
        }
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove.mutateAsync(removeTarget.id);
          setRemoveTarget(null);
          toast.success('Member removed.');
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        title="Revoke this invitation?"
        description={
          revokeTarget
            ? `${revokeTarget.email} will no longer be able to accept this invite.`
            : ''
        }
        confirmLabel="Revoke"
        variant="destructive"
        pending={revoke.isPending}
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revoke.mutateAsync(revokeTarget.id);
          setRevokeTarget(null);
          toast.success('Invitation revoked.');
        }}
      />
    </>
  );
}

function MemberRow({
  member: m,
  canManage,
  actorRole,
  isSelf,
  customOptions,
  onChangeRole,
  onExtras,
  onRemove,
  onRevoke,
  onResend,
  resending,
}: {
  member: WorkspaceMembershipWithUser;
  canManage: boolean;
  actorRole: WorkspaceRole | null;
  isSelf: boolean;
  customOptions: { value: string; label: string }[];
  /** A preset enum value or `custom:<roleId>`. */
  onChangeRole: (value: string) => void;
  onExtras: () => void;
  onRemove: () => void;
  onRevoke: () => void;
  onResend: () => void;
  resending: boolean;
}) {
  const isOwner = m.role === 'OWNER';
  // Admins may now change any non-owner member's role (including other
  // admins); only the OWNER row and the actor's own row stay locked. Mirrors
  // the server guard in WorkspacesService.updateMemberRole.
  const canModifyTarget = canManage && !isOwner && !isSelf;
  const options = visibleRoleOptions(actorRole);
  return (
    <tr className="border-t border-line">
      <td className="px-3 py-3">
        <div className="flex items-center gap-3">
          <UserAvatar size="md" name={m.user.name || m.user.email} image={m.user.image} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">
              {m.user.name || m.user.email}
            </div>
            <div className="truncate text-xs text-ink-muted">{m.user.email}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        {canModifyTarget ? (
          <Select
            value={memberRoleValue(m)}
            onValueChange={(v) => {
              if (v !== 'CLIENT') onChangeRole(v);
            }}
          >
            <SelectTrigger
              className="w-[140px]"
              aria-label={`Change role for ${m.user.name || m.user.email}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {m.role === 'CLIENT' ? (
                // Keeps a legacy CLIENT row's current value visible; it can
                // only be moved to one of the roles below.
                <SelectItem value="CLIENT" disabled>
                  {ROLE_LABEL.CLIENT}
                </SelectItem>
              ) : null}
              {options.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
              {customOptions.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge tone={ROLE_TONE[m.role]}>
            {isOwner ? <ShieldCheck className="h-3 w-3" aria-hidden /> : null}
            {customOptions.find((o) => o.value === memberRoleValue(m))?.label ?? ROLE_LABEL[m.role]}
            {isSelf && !isOwner ? <span className="ml-1 text-[10px] text-ink-muted">(you)</span> : null}
          </Badge>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-ink-muted">{companyRoleLabel(m.companyRole) ?? '-'}</td>
      <td className="px-3 py-3">
        {m.pending ? (
          <Badge tone="neutral" aria-label={`Pending invitation for ${m.user.email}`}>
            Pending
          </Badge>
        ) : (
          <Badge tone="info">
            <MailCheck className="h-3 w-3" aria-hidden />
            Active
          </Badge>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-ink-muted">
        <span title={absoluteTime(m.joinedAt)}>{relativeTime(m.joinedAt)}</span>
      </td>
      {canManage ? (
        <td className="px-3 py-3 text-right">
          <div className="flex justify-end gap-1">
            {m.pending ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Resend invitation to ${m.user.email}`}
                  onClick={onResend}
                  disabled={resending}
                >
                  <RefreshCw className="h-4 w-4 text-ink-muted" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Revoke invitation for ${m.user.email}`}
                  onClick={onRevoke}
                >
                  <Copy className="hidden h-4 w-4" aria-hidden />
                  <UserMinus className="h-4 w-4 text-ink-muted" />
                </Button>
              </>
            ) : canModifyTarget ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Permission extras for ${m.user.name || m.user.email}`}
                  onClick={onExtras}
                >
                  <SlidersHorizontal className="h-4 w-4 text-ink-muted" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${m.user.name || m.user.email}`}
                  onClick={onRemove}
                >
                  <UserMinus className="h-4 w-4 text-ink-muted" />
                </Button>
              </>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  actorRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorRole: WorkspaceRole | null;
}) {
  const invite = useInviteWorkspaceMember();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole | typeof AUTO_ROLE>(AUTO_ROLE);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inviteOptions = visibleRoleOptions(actorRole);

  const reset = () => {
    setEmail('');
    setName('');
    setRole(AUTO_ROLE);
    setFieldError(null);
  };

  async function submit() {
    setFieldError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFieldError('Enter an email address.');
      return;
    }
    try {
      const result = await invite.mutateAsync({
        email: trimmedEmail,
        ...(role === AUTO_ROLE ? {} : { role }),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onOpenChange(false);
      reset();
      if (result.invitationUrl) {
        copyInvitationToast(result.invitationUrl, result.user.email, result.invitationCode);
      } else {
        toast.success(`Added ${result.user.name || result.user.email} to the workspace.`);
      }
    } catch (err) {
      // The reason is shown inline under the field - no toast as well.
      markErrorReported();
      // 409 = already a member; anything else gets the server's readable
      // reason (validation detail, permission, network) or a plain fallback.
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : undefined;
      if (status === 409) {
        setFieldError('User is already a member of this workspace.');
      } else {
        setFieldError(getErrorMessage(err) ?? "Couldn't add this member.");
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Invite a member</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            We&apos;ll create their account and add them to the workspace immediately. They&apos;ll
            show as &ldquo;Pending&rdquo; until they accept the invitation link.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldError) setFieldError(null);
              }}
              placeholder="teammate@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">Display name (optional)</Label>
            <Input
              id="invite-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_ROLE}>
                  <span className="flex flex-col">
                    <span>From company role</span>
                    <span className="text-xs text-ink-muted">
                      Company admins join as Admin, everyone else as Member.
                    </span>
                  </span>
                </SelectItem>
                {inviteOptions.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    <span className="flex flex-col">
                      <span>{r.label}</span>
                      <span className="text-xs text-ink-muted">{r.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {fieldError ? (
            <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-xs text-state-error">
              {fieldError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={invite.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={invite.isPending}>
            {invite.isPending ? 'Inviting…' : 'Send invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
