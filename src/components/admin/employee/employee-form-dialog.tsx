import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createEmployeeFn, updateEmployeeFn } from '@/server/employees/employee.fns'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Employee } from '@/types/domain'

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  status: z.enum(['ACTIVE', 'INACTIVE']),
})

type FormValues = z.infer<typeof formSchema>

export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee?: Employee
}) {
  const isEdit = Boolean(employee)
  const queryClient = useQueryClient()
  const createEmployee = useServerFn(createEmployeeFn)
  const updateEmployee = useServerFn(updateEmployeeFn)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', email: '', status: 'ACTIVE' },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        name: employee?.name ?? '',
        email: employee?.email ?? '',
        status: employee?.status ?? 'ACTIVE',
      })
    }
  }, [open, employee, form])

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      if (isEdit && employee) {
        return updateEmployee({ data: { id: employee.id, ...values } })
      }
      return createEmployee({ data: values })
    },
    onSuccess: (saved) => {
      toast.success(
        isEdit ? 'Employee updated' : `Employee created (${saved.employee_code})`,
      )
      void queryClient.invalidateQueries({ queryKey: ['employees'] })
      void queryClient.invalidateQueries({ queryKey: ['employee', saved.id] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit employee' : 'New employee'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this agency staff member.'
              : 'An employee code is assigned automatically.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="employee-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="E1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email (optional)</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="employee-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create employee'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
