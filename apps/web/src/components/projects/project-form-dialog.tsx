'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { createProjectSchema, type CreateProjectInput, ProjectStatus } from '@botss/shared-types';

import { useCreateProject } from '@/hooks/use-projects';

interface Props {
  onClose: () => void;
  /** When set, the project is created already linked to this client. The
   * field is omitted from the form because the entry point already implies it. */
  defaultClientId?: string;
}

export function ProjectFormDialog({ onClose, defaultClientId }: Props) {
  const create = useCreateProject();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      status: 'ACTIVE',
      ...(defaultClientId ? { clientId: defaultClientId } : {}),
    },
  });

  const onSubmit = async (data: CreateProjectInput) => {
    try {
      await create.mutateAsync(data);
      onClose();
    } catch {
      // Toasted by the hook's onError; keep the dialog open so the user can retry.
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink/40 p-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <h2 className="text-base font-semibold">New project</h2>
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)}>
          <div>
            <label className="label">
              Name
              <RequiredMark />
            </label>
            <input className="input" {...register('name')} />
            {errors.name && <p className="text-xs text-state-error mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <label className="label">Key (optional)</label>
            <input className="input" {...register('key')} placeholder="Auto-generated from the name if left blank" />
            <p className="text-xs text-ink-muted mt-1">
              Uppercase letters/digits, 2-10 chars. Leave blank to generate one
              from the project name.
            </p>
            {errors.key && <p className="text-xs text-state-error mt-1">{errors.key.message}</p>}
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" {...register('status')}>
              {ProjectStatus.options.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <textarea className="input min-h-[80px]" {...register('description')} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create project'}
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
