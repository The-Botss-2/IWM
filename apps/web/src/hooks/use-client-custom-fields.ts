'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError } from '@botss/api-client';
import type { ClientCustomFieldValueList, CustomFieldDefinition } from '@botss/shared-types';

import { useAbility } from '@/lib/ability';
import { getApi } from '@/lib/api';
import { type CustomFieldPayload, isEmptyValue } from '@/lib/custom-field-values';
import { toastError, toastErrorMessage } from '@/lib/toast';
import { useCustomFieldDefinitions } from './use-custom-fields';

const clientCustomFieldsKey = (clientId: string) =>
  ['client-hub', clientId, 'custom-fields'] as const;

export interface ClientCustomField {
  definition: CustomFieldDefinition;
  value: CustomFieldPayload;
}

const READ_ONLY_MESSAGE = 'You can view these fields but not change them on this client.';

function isStatus(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status;
}

/**
 * The workspace's CLIENT custom fields with this client's values, in the
 * order set in Settings. `readOnly` is a UX hint (CASL, or a 403 from the
 * API on a previous save); the server decides on every write.
 */
export function useClientCustomFields(clientId: string) {
  const qc = useQueryClient();
  const key = clientCustomFieldsKey(clientId);
  const canUpdate = useAbility().can('update', 'Client');
  const [forbidden, setForbidden] = useState(false);

  const definitions = useCustomFieldDefinitions({ scope: 'CLIENT' });
  const values = useQuery({
    queryKey: key,
    queryFn: () => getApi().clients.customFields(clientId),
    enabled: !!clientId,
    staleTime: 30_000,
    retry: (count, err) => !isStatus(err, 403) && !isStatus(err, 404) && count < 2,
  });

  const fields = useMemo<ClientCustomField[]>(() => {
    const byDef = new Map((values.data?.items ?? []).map((v) => [v.definitionId, v.value]));
    return [...(definitions.data ?? [])]
      .filter((d) => d.scope === 'CLIENT')
      .sort((a, b) => a.position - b.position)
      .map((definition) => ({ definition, value: byDef.get(definition.id) ?? null }));
  }, [definitions.data, values.data]);

  const patch = (definitionId: string, value: CustomFieldPayload) => {
    const previous = qc.getQueryData<ClientCustomFieldValueList>(key);
    if (previous) {
      const now = new Date();
      const rest = previous.items.filter((v) => v.definitionId !== definitionId);
      const existing = previous.items.find((v) => v.definitionId === definitionId);
      qc.setQueryData<ClientCustomFieldValueList>(key, {
        ...previous,
        items:
          value === null
            ? rest
            : [
                ...rest,
                {
                  id: existing?.id ?? `temp-${definitionId}`,
                  definitionId,
                  entityId: clientId,
                  value,
                  createdAt: existing?.createdAt ?? now,
                  updatedAt: now,
                },
              ],
      });
    }
    return previous;
  };

  const onWriteError = (
    err: unknown,
    previous: ClientCustomFieldValueList | undefined,
    fallback: string,
  ) => {
    if (previous) qc.setQueryData(key, previous);
    if (isStatus(err, 403)) {
      setForbidden(true);
      toastErrorMessage(READ_ONLY_MESSAGE);
      return;
    }
    toastError(err, fallback);
  };

  const set = useMutation({
    meta: { errorTitle: "Couldn't save field" },
    mutationFn: ({ definitionId, value }: { definitionId: string; value: CustomFieldPayload }) =>
      getApi().clients.setCustomField(clientId, definitionId, { value }),
    onMutate: async ({ definitionId, value }) => {
      await qc.cancelQueries({ queryKey: key });
      return { previous: patch(definitionId, value) };
    },
    onError: (err, _vars, ctx) => onWriteError(err, ctx?.previous, "Couldn't save the field"),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  const clear = useMutation({
    meta: { errorTitle: "Couldn't clear field" },
    mutationFn: (definitionId: string) => getApi().clients.clearCustomField(clientId, definitionId),
    onMutate: async (definitionId) => {
      await qc.cancelQueries({ queryKey: key });
      return { previous: patch(definitionId, null) };
    },
    onError: (err, _vars, ctx) => onWriteError(err, ctx?.previous, "Couldn't clear the field"),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  /** Save a value; an empty one (null, '', []) clears the field instead. */
  const save = (definitionId: string, value: CustomFieldPayload) => {
    if (isEmptyValue(value)) clear.mutate(definitionId);
    else set.mutate({ definitionId, value });
  };

  const valuesForbidden = isStatus(values.error, 403) || isStatus(values.error, 404);

  return {
    fields,
    isLoading: definitions.isLoading || values.isLoading,
    isError: definitions.isError || (values.isError && !valuesForbidden),
    /** The values could not be read for this viewer (403/404): hide the section. */
    unavailable: valuesForbidden,
    refetch: () => {
      void definitions.refetch();
      void values.refetch();
    },
    readOnly: !canUpdate || forbidden,
    save,
    clear: (definitionId: string) => clear.mutate(definitionId),
  };
}
