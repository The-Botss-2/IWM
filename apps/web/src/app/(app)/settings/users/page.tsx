'use client';

import { Download, Loader2, LogOut, Plus, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type {
  AdminCreateUserInput,
  AdminImportWebmailUserInput,
  AdminUserListItem,
  SystemRole,
  WebmailCandidate,
} from '@botss/shared-types';

import { UserAccessDialog } from '@/components/roles/user-access-dialog';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getApi } from '@/lib/api';
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
import { PasswordInput } from '@/components/ui/password-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAdminUsers,
  useCreateAdminUser,
  useDeleteAdminUser,
  useImportWebmailUser,
  useRevokeUserSessions,
  useUpdateAdminUser,
  useWebmailCandidates,
} from '@/hooks/use-admin-users';
import { useSessionContext } from '@/components/auth/session-gate';
import { absoluteTime, relativeTime } from '@/lib/time';
import { usePermissions } from '@/hooks/use-permissions';
import { useRoles } from '@/hooks/use-roles';

// Mirrors the API's ADMIN_EMAIL and CPANEL_DOMAIN (the web build can't read
// the API env). Empty when unset: no account is shown as protected, and no
// address is treated as a cPanel-managed mailbox.
const PRIMARY_ADMIN_EMAIL = (process.env.NEXT_PUBLIC_ADMIN_EMAIL ?? '').trim().toLowerCase();
const CPANEL_DOMAIN = (process.env.NEXT_PUBLIC_CPANEL_DOMAIN ?? '').trim().toLowerCase();

function isPrimaryAdminEmail(email: string): boolean {
  return !!PRIMARY_ADMIN_EMAIL && email.toLowerCase() === PRIMARY_ADMIN_EMAIL;
}

function isOnCpanelDomain(email: string): boolean {
  return !!CPANEL_DOMAIN && email.toLowerCase().endsWith(`@${CPANEL_DOMAIN}`);
}

const ROLE_LABEL: Record<SystemRole, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project manager',
  EMPLOYEE: 'Employee',
  HR: 'HR',
  FINANCE: 'Finance',
};

const ROLE_TONE: Record<SystemRole, 'brand' | 'info' | 'neutral'> = {
  // SUPER_ADMIN is the loudest tier (platform operator), so it gets
  // the brand pill same as ADMIN / HR.
  SUPER_ADMIN: 'brand',
  ADMIN: 'brand',
  PROJECT_MANAGER: 'info',
  EMPLOYEE: 'neutral',
  // HR and FINANCE share the brand pill with ADMIN - the privileged
  // roles outside the workspace layer.
  HR: 'brand',
  FINANCE: 'brand',
};

export default function UsersAdminPage() {
  const session = useSessionContext();
  const role = session.data?.user?.systemRole;
  // Both tenant ADMIN and platform SUPER_ADMIN see this page, always for
  // their own organization only. Only the SUPER_ADMIN gets the SUPER_ADMIN
  // grant option in dialogs.
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isSuperAdmin = role === 'SUPER_ADMIN';
  // HR can add users and view the list, but not edit/delete or grant admin
  // roles. The server enforces all of this; these flags keep the UI honest.
  const isHr = role === 'HR';
  const perms = usePermissions();
  const canManageUsers = isAdmin || isHr || perms.has('users.manage');
  const canManageRoles = perms.canManageRoles;
  const roles = useRoles(canManageRoles);
  const customRoleName = (id: string | null | undefined) =>
    id ? roles.data?.company.find((r) => r.id === id)?.name : undefined;
  const [accessTarget, setAccessTarget] = useState<AdminUserListItem | null>(null);

  const [search, setSearch] = useState('');
  const users = useAdminUsers({ search: search.trim() || undefined });
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUserListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUserListItem | null>(null);

  const remove = useDeleteAdminUser();
  const revokeSessions = useRevokeUserSessions();
  const [signOutTarget, setSignOutTarget] = useState<AdminUserListItem | null>(null);

  if (session.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!canManageUsers) {
    return (
      <div className="py-12 text-center">
        <h2 className="text-lg font-semibold text-ink">Admin only</h2>
        <p className="mt-1 text-sm text-ink-muted">
          You need administrator privileges to manage users.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Users</h2>
          <p className="text-sm text-ink-muted">
            Create, edit, and remove user accounts. The Botss is closed to
            public sign-ups - every user starts here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin ? (
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Download className="h-4 w-4" />
              Import from webmail
            </Button>
          ) : null}
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New user
          </Button>
        </div>
      </header>

      <div className="rounded-lg border border-line bg-bg-surface p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            className="max-w-md flex-1"
          />
        </div>

        <div className="mt-4 overflow-x-auto">
          {users.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : !users.data || users.data.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              No users match.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((u) => (
                  <tr key={u.id} className="border-t border-line">
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar size="md" name={u.name} image={u.image} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-ink">
                            {u.name}
                          </div>
                          <div className="truncate text-xs text-ink-muted">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={ROLE_TONE[u.systemRole]}>
                        {customRoleName(u.customRoleId) ?? ROLE_LABEL[u.systemRole]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-muted">
                      <span title={absoluteTime(u.createdAt)}>
                        {relativeTime(u.createdAt)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {/* Edit + delete are admin-only; HR can add + view but
                            not modify existing users (server enforces too). */}
                        {canManageRoles ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Access for ${u.name}`}
                            onClick={() => setAccessTarget(u)}
                          >
                            <ShieldCheck className="h-4 w-4 text-ink-muted" />
                          </Button>
                        ) : null}
                        {isAdmin ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${u.name}`}
                              onClick={() => setEditTarget(u)}
                            >
                              <UserCog className="h-4 w-4 text-ink-muted" />
                            </Button>
                            {u.id !== session.data?.user?.id ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Sign out ${u.name} everywhere`}
                                title="Sign out everywhere"
                                onClick={() => setSignOutTarget(u)}
                              >
                                <LogOut className="h-4 w-4 text-ink-muted" />
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${u.name}`}
                              onClick={() => setDeleteTarget(u)}
                              disabled={isPrimaryAdminEmail(u.email)}
                            >
                              <Trash2 className="h-4 w-4 text-ink-muted" />
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-ink-disabled">-</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        isSuperAdmin={isSuperAdmin}
        canGrantAdmin={isAdmin}
      />
      <ImportWebmailDialog open={importOpen} onOpenChange={setImportOpen} />
      <UserAccessDialog
        user={accessTarget}
        onOpenChange={(open) => {
          if (!open) setAccessTarget(null);
        }}
      />
      <EditUserDialog
        user={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        isSuperAdmin={isSuperAdmin}
      />
      <ConfirmDialog
        open={!!signOutTarget}
        onOpenChange={(next) => !next && setSignOutTarget(null)}
        title="Sign out everywhere"
        description={`${signOutTarget?.email ?? ''} will be signed out of every device and must sign in again.`}
        confirmLabel="Sign out everywhere"
        variant="destructive"
        pending={revokeSessions.isPending}
        onConfirm={async () => {
          if (!signOutTarget) return;
          try {
            await revokeSessions.mutateAsync(signOutTarget.id);
          } catch {
            // toasted by the hook's onError
          } finally {
            setSignOutTarget(null);
          }
        }}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        title="Delete user"
        description={`This permanently removes ${deleteTarget?.email ?? ''} from The Botss. Their workspace memberships and sessions are revoked. This cannot be undone.`}
        confirmLabel="Delete user"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await remove.mutateAsync(deleteTarget.id);
          } catch {
            // toasted by the hook's onError
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  isSuperAdmin,
  canGrantAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSuperAdmin: boolean;
  canGrantAdmin: boolean;
}) {
  const create = useCreateAdminUser();
  const [form, setForm] = useState<AdminCreateUserInput>({
    email: '',
    name: '',
    password: '',
    systemRole: 'EMPLOYEE',
  });
  const [error, setError] = useState<string | null>(null);

  const reset = () =>
    setForm({ email: '', name: '', password: '', systemRole: 'EMPLOYEE' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.email.trim() || !form.name.trim() || !form.password) {
      setError('Email, name, and password are required.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    try {
      await create.mutateAsync(form);
      reset();
      onOpenChange(false);
    } catch {
      // toast surfaced by hook
    }
  };

  const isCpanelManaged = isOnCpanelDomain(form.email);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            The password you set is also the user&apos;s login.
            {CPANEL_DOMAIN
              ? ` For @${CPANEL_DOMAIN} addresses it doubles as the webmail password and the Mail tab is auto-configured.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit} noValidate>
          <div className="space-y-1">
            <Label htmlFor="nu-email">Email</Label>
            <Input
              id="nu-email"
              type="email"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-name">Name</Label>
            <Input
              id="nu-name"
              autoComplete="off"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-password">Password</Label>
            <PasswordInput
              id="nu-password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
              required
            />
            {isCpanelManaged ? (
              <p className="text-[11px] text-ink-muted">
                Must match the user&apos;s webmail password - the system uses it to
                sign in to their mailbox.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-role">Role</Label>
            <Select
              value={form.systemRole}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, systemRole: v as SystemRole }))
              }
            >
              <SelectTrigger id="nu-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EMPLOYEE">Employee</SelectItem>
                <SelectItem value="PROJECT_MANAGER">Project manager</SelectItem>
                <SelectItem value="HR">HR</SelectItem>
                <SelectItem value="FINANCE">Finance</SelectItem>
                {/* HR actors can't grant Admin (would be a self-escalation);
                    the server rejects it too. */}
                {canGrantAdmin ? (
                  <SelectItem value="ADMIN">Admin</SelectItem>
                ) : null}
                {/* SUPER_ADMIN can only be granted by another SUPER_ADMIN,
                    and the target must end up in the root org. The DB
                    trigger backstops both rules - we hide the option for
                    everyone else to avoid a guaranteed-403 trip. */}
                {isSuperAdmin ? (
                  <SelectItem value="SUPER_ADMIN">Super admin</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                <>Create user</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  onOpenChange,
  isSuperAdmin,
}: {
  user: AdminUserListItem | null;
  onOpenChange: (open: boolean) => void;
  isSuperAdmin: boolean;
}) {
  const update = useUpdateAdminUser();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [systemRole, setSystemRole] = useState<SystemRole>('EMPLOYEE');
  const [timesheetExempt, setTimesheetExempt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate when a new target is set.
  if (user && name === '' && password === '' && error === null) {
    setName(user.name);
    setSystemRole(user.systemRole);
    setTimesheetExempt(user.timesheetExempt);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);
    if (password && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    try {
      await update.mutateAsync({
        id: user.id,
        input: {
          ...(name && name !== user.name ? { name } : {}),
          ...(password ? { password } : {}),
          ...(systemRole !== user.systemRole ? { systemRole } : {}),
          ...(timesheetExempt !== user.timesheetExempt ? { timesheetExempt } : {}),
        },
      });
      setName('');
      setPassword('');
      onOpenChange(false);
    } catch {
      // toast surfaced by hook
    }
  };

  const open = !!user;
  const isPrimaryAdmin = !!user && isPrimaryAdminEmail(user.email);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName('');
          setPassword('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>{user?.email}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit} noValidate>
          <div className="space-y-1">
            <Label htmlFor="eu-name">Name</Label>
            <Input
              id="eu-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="eu-password">New password</Label>
            <PasswordInput
              id="eu-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current password"
            />
            {user && isOnCpanelDomain(user.email) ? (
              <p className="text-[11px] text-ink-muted">
                Changing the password here also updates the user&apos;s Mail tab
                credentials so webmail and CRM stay in sync.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="eu-role">Role</Label>
            <Select
              value={systemRole}
              onValueChange={(v) => setSystemRole(v as SystemRole)}
              disabled={isPrimaryAdmin}
            >
              <SelectTrigger id="eu-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EMPLOYEE">Employee</SelectItem>
                <SelectItem value="PROJECT_MANAGER">Project manager</SelectItem>
                <SelectItem value="HR">HR</SelectItem>
                <SelectItem value="FINANCE">Finance</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
                {/* SUPER_ADMIN option only when the actor is a SUPER_ADMIN
                    themselves. Server-side check additionally requires the
                    target user to be in the Botss root org. */}
                {isSuperAdmin ? (
                  <SelectItem value="SUPER_ADMIN">Super admin</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {isPrimaryAdmin ? (
              <p className="text-[11px] text-ink-muted">
                The primary admin role is locked.
              </p>
            ) : null}
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-3">
            <Checkbox
              checked={timesheetExempt}
              onCheckedChange={(v) => setTimesheetExempt(v === true)}
              className="mt-0.5"
              aria-label="Exempt from timesheets"
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Exempt from timesheets</span>
              <span className="mt-0.5 block text-[11px] text-ink-muted">
                Skip this user in the timesheet-warning checks. Use for people
                not obligated to submit timesheets.
              </span>
            </span>
          </label>
          {error ? (
            <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>Save</>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportWebmailDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Only fetch the candidate list while the dialog is open so we don't poll
  // cPanel on every Users-tab visit.
  const candidates = useWebmailCandidates(open);
  const importUser = useImportWebmailUser();
  const [selected, setSelected] = useState<WebmailCandidate | null>(null);
  const [form, setForm] = useState<AdminImportWebmailUserInput>({
    email: '',
    name: '',
    password: '',
    systemRole: 'EMPLOYEE',
  });
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSelected(null);
    setForm({ email: '', name: '', password: '', systemRole: 'EMPLOYEE' });
    setError(null);
  };

  const pick = (c: WebmailCandidate) => {
    setSelected(c);
    setForm((s) => ({
      ...s,
      email: c.email,
      // Default the display name to the local part of the email, title-cased,
      // so the admin only has to retype if they want something nicer.
      name:
        c.email.split('@')[0]?.replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) =>
          m.toUpperCase(),
        ) ?? '',
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.email || !form.name.trim() || !form.password) {
      setError('Name and password are required.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    try {
      await importUser.mutateAsync(form);
      reset();
      onOpenChange(false);
    } catch {
      // toast surfaced by hook
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import existing webmail user</DialogTitle>
          <DialogDescription>
            Pick a mailbox that already exists in cPanel webmail. The password
            you choose will be applied to both the CRM credential and the
            webmail mailbox so the user signs in with the same secret in both.
          </DialogDescription>
        </DialogHeader>

        {selected == null ? (
          <div className="max-h-[400px] overflow-y-auto">
            {candidates.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : candidates.isError ? (
              <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
                Couldn&apos;t reach cPanel. Check the CPANEL_API_TOKEN configuration.
              </p>
            ) : !candidates.data || candidates.data.items.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-muted">
                No unlinked mailboxes found. Every webmail account is already
                in the CRM.
              </p>
            ) : (
              <ul className="divide-y divide-line" role="list">
                {candidates.data.items.map((c) => (
                  <li
                    key={c.email}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">
                        {c.email}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {formatBytes(c.diskUsedBytes)} used
                        {c.quotaMb > 0
                          ? ` of ${c.quotaMb} MB`
                          : ' (unlimited quota)'}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => pick(c)}
                    >
                      Import
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <form className="space-y-3" onSubmit={submit} noValidate>
            <div className="rounded-md border border-line bg-bg-subtle px-3 py-2 text-sm">
              <div className="text-xs text-ink-muted">Importing</div>
              <div className="font-mono text-ink">{selected.email}</div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-name">Name</Label>
              <Input
                id="iw-name"
                value={form.name}
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-password">Password</Label>
              <PasswordInput
                id="iw-password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) =>
                  setForm((s) => ({ ...s, password: e.target.value }))
                }
                required
              />
              <p className="text-[11px] text-ink-muted">
                This sets the user&apos;s CRM password AND replaces their
                current webmail password. Give them the new password after
                import.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="iw-role">Role</Label>
              <Select
                value={form.systemRole}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, systemRole: v as SystemRole }))
                }
              >
                <SelectTrigger id="iw-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">Employee</SelectItem>
                  <SelectItem value="PROJECT_MANAGER">Project manager</SelectItem>
                  <SelectItem value="FINANCE">Finance</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error ? (
              <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
                {error}
              </p>
            ) : null}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSelected(null)}
                disabled={importUser.isPending}
              >
                Back
              </Button>
              <Button type="submit" disabled={importUser.isPending}>
                {importUser.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                  </>
                ) : (
                  <>Import {selected.email}</>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
