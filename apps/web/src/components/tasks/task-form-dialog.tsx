'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import {
  createTaskSchema,
  type CreateTaskInput,
  TaskPriority,
  TaskStatus,
} from '@botss/shared-types';

import { useCreateTask } from '@/hooks/use-tasks';

interface Props {
  projectId: string;
  defaultStatus?: CreateTaskInput['status'];
  onClose: () => void;
}

export function TaskFormDialog({ projectId, defaultStatus, onClose }: Props) {
  const create = useCreateTask();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      projectId,
      status: defaultStatus ?? 'BACKLOG',
      priority: 'MEDIUM',
    },
  });

  const onSubmit = async (data: CreateTaskInput) => {
    try {
      await create.mutateAsync({ ...data, projectId });
      onClose();
    } catch {
      // Toasted by the hook's onError; keep the dialog open so the user can retry.
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink/40 p-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <h2 className="text-base font-semibold">New task</h2>
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)}>
          <input type="hidden" {...register('projectId')} />
          <div>
            <label className="label">
              Title
              <RequiredMark />
            </label>
            <input className="input" {...register('title')} />
            {errors.title && <p className="text-xs text-state-error mt-1">{errors.title.message}</p>}
          </div>
          <div>
            <label className="label">Description</label>
            <textarea className="input min-h-[80px]" {...register('description')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Status</label>
              <select className="input" {...register('status')}>
                {TaskStatus.options.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Priority</label>
              <select className="input" {...register('priority')}>
                {TaskPriority.options.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Start Date</label>
              <input type="date" className="input" {...register('startDate')} />
              {errors.startDate && (
                <p className="text-xs text-state-error mt-1">{errors.startDate.message}</p>
              )}
            </div>
            <div>
              <label className="label">Due Date</label>
              <input type="date" className="input" {...register('dueDate')} />
              {errors.dueDate && (
                <p className="text-xs text-state-error mt-1">{errors.dueDate.message}</p>
              )}
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            Dates are optional and can be set or changed later from the task panel.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create task'}
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
