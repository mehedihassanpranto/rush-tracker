import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { listPlansFn, setOrganizationPlanFn } from '@/server/platform/subscription.fns'
import { formatBdt } from '@/lib/money/money'
import { checkPlanLimit, planLimit } from '@/lib/subscription/plans'
import type { OrganizationUsage, PlanLimitKind } from '@/lib/subscription/plans'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

const NO_PLAN = 'none'
const KIND_NAMES: Record<PlanLimitKind, string> = {
  clients: 'active clients',
  adAccounts: 'ad accounts',
  staff: 'staff logins',
}

export function ChangePlanDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  currentPlanId,
  billingExempt,
  usage,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  organizationName: string
  currentPlanId: string | null
  billingExempt: boolean
  usage: OrganizationUsage
}) {
  const queryClient = useQueryClient()
  const listPlans = useServerFn(listPlansFn)
  const setPlan = useServerFn(setOrganizationPlanFn)
  const [planId, setPlanId] = useState<string>(NO_PLAN)
  const [exempt, setExempt] = useState(false)

  const { data: plans } = useQuery({
    queryKey: ['subscription-plans'],
    queryFn: () => listPlans(),
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      setPlanId(currentPlanId ?? NO_PLAN)
      setExempt(billingExempt)
    }
  }, [open, currentPlanId, billingExempt])

  const selected = plans?.find((p) => p.id === planId) ?? null
  // Downgrading is allowed, but say exactly what the agency is already over.
  const overages = selected
    ? (['clients', 'adAccounts', 'staff'] as const).flatMap((kind) => {
        const lim = planLimit(selected, kind)
        const r = checkPlanLimit(usage[kind], 0, lim)
        return r.ok ? [] : [`${usage[kind]} ${KIND_NAMES[kind]} (limit ${lim})`]
      })
    : []

  const mutation = useMutation({
    mutationFn: () =>
      setPlan({
        data: {
          organization_id: organizationId,
          plan_id: planId === NO_PLAN ? null : planId,
          billing_exempt: exempt,
        },
      }),
    onSuccess: () => {
      toast.success('Plan updated')
      void queryClient.invalidateQueries({ queryKey: ['organization-subscription', organizationId] })
      void queryClient.invalidateQueries({ queryKey: ['organization-billing'] })
      void queryClient.invalidateQueries({ queryKey: ['subscription-plans'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update plan'),
  })

  // Inactive plans stay selectable only if the agency is already on one.
  const options = (plans ?? []).filter((p) => p.is_active || p.id === currentPlanId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>
            {organizationName}'s plan sets its limits. Changing it never removes
            anything the agency already has.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plan-select">Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger id="plan-select" className="w-full">
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PLAN}>No plan (no limits)</SelectItem>
                {options.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {formatBdt(p.monthly_fee_bdt)}/month
                    {!p.is_active ? ' (retired)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {overages.length > 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              This agency is already over this plan: {overages.join(', ')}. It
              keeps everything, but can't add more of these until it's under the
              limit.
            </p>
          )}
          <div className="flex items-start gap-2">
            <Checkbox
              id="billing-exempt"
              checked={exempt}
              onCheckedChange={(c) => setExempt(c === true)}
            />
            <div className="space-y-1 leading-none">
              <Label htmlFor="billing-exempt">Billing exempt</Label>
              <p className="text-xs text-muted-foreground">
                Never shown as unpaid or overdue. Limits still apply.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !plans}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
