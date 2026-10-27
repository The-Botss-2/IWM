'use client';

import { useMemo } from 'react';

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useClients } from '@/hooks/use-clients';

interface Props {
  value: string | null;
  onChange: (clientId: string | null) => void;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ClientCombobox({
  value,
  onChange,
  placeholder = 'Client',
  clearable = true,
  disabled,
  className,
}: Props) {
  const { data, isLoading, isError } = useClients({ pageSize: 100 });

  const options = useMemo<ComboboxOption[]>(() => {
    if (!data?.items) return [];
    return data.items.map((c) => ({
      value: c.id,
      label: c.name,
      description: c.legalName ?? c.email ?? undefined,
    }));
  }, [data]);

  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={isLoading ? 'Loading clients…' : isError ? "Couldn't load" : placeholder}
      searchPlaceholder="Search clients"
      emptyText="No clients found"
      clearable={clearable}
      clearLabel="No client"
      disabled={disabled || isLoading}
      className={className}
    />
  );
}
