import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  assignEmployeeToClientFn,
  listAssignableEmployeesFn,
} from '@/server/employees/employee.fns'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Assign an existing employee to a client (spec-alike to AssignAccountDialog). */
export function AssignEmployeeDialog({
  open,
  onOpenChange,
  clientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
}) {
  const queryClient = useQueryClient()
  const listAssignable = useServerFn(listAssignableEmployeesFn)
  const assign = useServerFn(assignEmployeeToClientFn)
  const [employeeId, setEmployeeId] = useState('')

  useEffect(() => {
    if (open) setEmployeeId('')
  }, [open])

  const { data: employees, isLoading } = useQuery({
    queryKey: ['assignable-employees', clientId],
    queryFn: () => listAssignable({ data: { client_id: clientId } }),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () =>
      assign({ data: { client_id: clientId, employee_id: employeeId } }),
    onSuccess: () => {
      toast.success('Employee assigned')
      void queryClient.invalidateQueries({ queryKey: ['client-employees', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['assignable-employees', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['employees'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to assign'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign employee</DialogTitle>
          <DialogDescription>
            Assigns an agency employee to service this client.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Employee</Label>
          <Select value={employeeId} onValueChange={setEmployeeId}>
            <SelectTrigger>
              <SelectValue
                placeholder={isLoading ? 'Loading…' : 'Select an employee'}
              />
            </SelectTrigger>
            <SelectContent>
              {employees?.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.employee_code} — {e.name}
                </SelectItem>
              ))}
              {!isLoading && (employees?.length ?? 0) === 0 && (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No unassigned employees
                </div>
              )}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!employeeId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
