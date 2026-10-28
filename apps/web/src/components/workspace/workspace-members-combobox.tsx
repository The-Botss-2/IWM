'use client';

import { useMemo } from 'react';

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserAvatar } from '@/components/ui/avatar';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';

interface Props {
  value: string | null;
  onChange: (userId: string | null) => void;
  placeholder?: string;
  clearable?: boolean;
  excludeUserIds?: readonly string[];
  disabled?: boolean;
  className?: string;
  /**
   * When provided, the member list is scoped to the workspace that owns this
   * project - required when the current user accesses a project as an outside
   * collaborator (project membership without workspace membership).
   */
  projectId?: string;
}

export function WorkspaceMembersCombobox({
  value,
  onChange,
  placeholder = 'Assignee',
  clearable = true,
  excludeUserIds,
  disabled,
  className,
  projectId,
}: Props) {
  const { data, isLoading, isError } = useWorkspaceMembers(projectId);

  const options = useMemo<ComboboxOption[]>(() => {
    if (!data) return [];
    return data
      .filter((m) => !excludeUserIds?.includes(m.userId))
      .map((m) => ({
        value: m.userId,
        label: m.user.name || m.user.email,
        description: m.user.email,
        leading: <UserAvatar size="sm" name={m.user.name || m.user.email} image={m.user.image} />,
      }));
  }, [data, excludeUserIds]);

  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={isLoading ? 'Loading members…' : isError ? "Couldn't load" : placeholder}
      searchPlaceholder="Search members"
      emptyText="No members found"
      clearable={clearable}
      clearLabel="Unassigned"
      disabled={disabled || isLoading}
      className={className}
    />
  );
}
