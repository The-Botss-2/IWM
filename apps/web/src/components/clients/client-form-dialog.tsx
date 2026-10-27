'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import {
  ClientStatus,
  createClientSchema,
  type CreateClientInput,
} from '@botss/shared-types';

import { useCreateClient } from '@/hooks/use-clients';
import { toast } from '@/lib/toast';

export function ClientFormDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateClient();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateClientInput>({
    resolver: zodResolver(createClientSchema),
    defaultValues: { status: 'PROSPECT' },
  });

  const onSubmit = async (data: CreateClientInput) => {
    try {
      await create.mutateAsync(data);
      toast.success('Client created.');
      onClose();
    } catch {
      // useCreateClient's onError already toasted; keep the dialog open to retry.
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink/40 p-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <h2 className="text-base font-semibold">New client</h2>
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)}>
          <div>
            <label className="label">
              Name
              <RequiredMark />
            </label>
            <input className="input" {...register('name')} />
            {errors.name && <p className="text-xs text-state-error mt-1">{errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Email</label>
              <input className="input" {...register('email')} />
            </div>
            <div>
              <label className="label">Industry</label>
              <input className="input" {...register('industry')} />
            </div>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" {...register('status')}>
              {ClientStatus.options.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RequiredMark() {
  return (
    <span className="ml-1 text-state-error" aria-label="required">
      *
    </span>
  );
}
