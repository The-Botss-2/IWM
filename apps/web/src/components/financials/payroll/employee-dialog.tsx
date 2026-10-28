'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  type PayrollEmployee,
  type PayrollPaymentMethod,
  updatePayrollEmployeeSchema,
  type UpdatePayrollEmployeeInput,
} from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useRemovePayrollEmployee, useUpdatePayrollEmployee } from '@/hooks/use-payroll';
import { PAYMENT_METHOD_LABELS, payrollAmount } from '@/lib/payroll';

interface FormValues {
  name: string;
  email: string;
  cnic: string;
  dateOfJoining: string;
  paymentMethod: PayrollPaymentMethod;
  monthlySalary: string;
  designation: string;
  bankName: string;
  accountTitle: string;
  accountNumber: string;
  isActive: boolean;
}

/** Salary, identity, payment and bank details, and active state for one person on payroll. */
export function EmployeeDialog({
  employee,
  onOpenChange,
}: {
  employee: PayrollEmployee | null;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdatePayrollEmployee();
  const remove = useRemovePayrollEmployee();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>();

  useEffect(() => {
    if (!employee) return;
    reset({
      name: employee.name,
      email: employee.email ?? '',
      cnic: employee.cnic ?? '',
      dateOfJoining: employee.dateOfJoining ?? '',
      paymentMethod: employee.paymentMethod,
      monthlySalary: employee.monthlySalary,
      designation: employee.designation ?? '',
      bankName: employee.bankName ?? '',
      accountTitle: employee.accountTitle ?? '',
      accountNumber: employee.accountNumber ?? '',
      isActive: employee.isActive,
    });
  }, [employee, reset]);

  const isActive = watch('isActive');
  const paymentMethod = watch('paymentMethod');
  const hasAccount = !!employee?.userId;

  async function onSubmit(values: FormValues) {
    if (!employee) return;
    const salary = payrollAmount(values.monthlySalary);
    if (salary === null || Number(salary) <= 0) {
      setError('monthlySalary', { message: 'Enter the monthly salary.' });
      return;
    }
    // Same schema the API validates with, so length limits match exactly.
    const parsed = updatePayrollEmployeeSchema.safeParse({
      ...(hasAccount ? {} : { name: values.name }),
      email: values.email.trim(),
      cnic: values.cnic.trim(),
      dateOfJoining: values.dateOfJoining,
      paymentMethod: values.paymentMethod,
      monthlySalary: salary,
      designation: values.designation,
      bankName: values.bankName,
      accountTitle: values.accountTitle,
      accountNumber: values.accountNumber,
      isActive: values.isActive,
    } satisfies UpdatePayrollEmployeeInput);
    if (!parsed.success) {
      const messages: Partial<Record<keyof FormValues, string>> = {
        name: 'Enter a name.',
        email: 'Enter a valid email address.',
        cnic: 'CNIC must have 13 digits, like 35202-1234567-1.',
        dateOfJoining: 'Enter a valid date.',
      };
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && field in values) {
          const key = field as keyof FormValues;
          setError(key, { message: messages[key] ?? 'Too long.' });
        }
      }
      return;
    }
    try {
      await update.mutateAsync({ id: employee.id, input: parsed.data });
      onOpenChange(false);
    } catch {
      // Toast raised by the hook.
    }
  }

  return (
    <>
      <Dialog open={!!employee} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{employee?.name ?? 'Person'}</DialogTitle>
            <DialogDescription>
              {hasAccount
                ? 'On the platform'
                : 'Paid through payroll only, with no platform account'}
            </DialogDescription>
          </DialogHeader>

          <form id="payroll-employee-form" className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
            {!hasAccount ? (
              <div className="space-y-1.5">
                <Label htmlFor="pe-name">Name</Label>
                <Input id="pe-name" aria-invalid={!!errors.name} {...register('name')} />
                {errors.name ? (
                  <p className="text-state-error text-xs">{errors.name.message}</p>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pe-salary">Monthly salary (PKR)</Label>
                <Input
                  id="pe-salary"
                  inputMode="decimal"
                  className="tabular-nums"
                  aria-invalid={!!errors.monthlySalary}
                  {...register('monthlySalary')}
                />
                {errors.monthlySalary ? (
                  <p className="text-state-error text-xs">{errors.monthlySalary.message}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-designation">Designation</Label>
                <Input
                  id="pe-designation"
                  placeholder="e.g. Software Engineer"
                  {...register('designation')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-email">Payslip email</Label>
                <Input
                  id="pe-email"
                  type="email"
                  autoComplete="off"
                  placeholder={hasAccount ? 'Their account email' : 'name@example.com'}
                  aria-invalid={!!errors.email}
                  {...register('email')}
                />
                {errors.email ? (
                  <p className="text-state-error text-xs">{errors.email.message}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-cnic">CNIC</Label>
                <Input
                  id="pe-cnic"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="35202-1234567-1"
                  className="tabular-nums"
                  aria-invalid={!!errors.cnic}
                  {...register('cnic')}
                />
                {errors.cnic ? (
                  <p className="text-state-error text-xs">{errors.cnic.message}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-doj">Date of joining</Label>
                <Input
                  id="pe-doj"
                  type="date"
                  aria-invalid={!!errors.dateOfJoining}
                  {...register('dateOfJoining')}
                />
                {errors.dateOfJoining ? (
                  <p className="text-state-error text-xs">{errors.dateOfJoining.message}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-method">Payment method</Label>
                <Select
                  value={paymentMethod}
                  onValueChange={(v) =>
                    setValue('paymentMethod', v as PayrollPaymentMethod, { shouldDirty: true })
                  }
                >
                  <SelectTrigger id="pe-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as PayrollPaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <fieldset className="border-line space-y-3 rounded-md border p-3">
              <legend className="text-ink-muted px-1 text-xs font-medium uppercase tracking-wide">
                Bank details
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pe-bank">Bank</Label>
                  <Input id="pe-bank" placeholder="e.g. Meezan Bank" {...register('bankName')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pe-title">Account title</Label>
                  <Input id="pe-title" {...register('accountTitle')} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-number">Account number / IBAN</Label>
                <Input id="pe-number" autoComplete="off" {...register('accountNumber')} />
              </div>
            </fieldset>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={isActive}
                onCheckedChange={(v) => setValue('isActive', v === true, { shouldDirty: true })}
                className="mt-0.5"
              />
              <span>
                Include in new payroll runs
                <span className="text-ink-muted block text-xs">
                  Turn off for someone on unpaid leave. They stay on the list.
                </span>
              </span>
            </label>
          </form>

          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              className="text-state-error"
              onClick={() => setConfirmRemove(true)}
            >
              Remove from payroll
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="payroll-employee-form"
                disabled={isSubmitting || update.isPending}
              >
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${employee?.name ?? 'this person'} from payroll?`}
        description="They won't be included in new payroll runs. Past runs and payslips keep their details."
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!employee) return;
          try {
            await remove.mutateAsync(employee.id);
            setConfirmRemove(false);
            onOpenChange(false);
          } catch {
            // Toast raised by the hook.
          }
        }}
      />
    </>
  );
}
