import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  getAgencyPaymentInstructionsFn,
  setAgencyPaymentInstructionsFn,
} from '@/server/platform/agency-billing.fns'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * Where agencies should send what they owe the platform. Shown as-is on each
 * agency's Platform Billing page (its SUPER_ADMIN only).
 */
export function AgencyPaymentInstructionsCard() {
  const queryClient = useQueryClient()
  const get = useServerFn(getAgencyPaymentInstructionsFn)
  const save = useServerFn(setAgencyPaymentInstructionsFn)
  const q = useQuery({ queryKey: ['platform-usd', 'payment-instructions'], queryFn: () => get() })
  const [value, setValue] = useState('')
  useEffect(() => {
    if (q.data !== undefined) setValue(q.data)
  }, [q.data])
  const mutation = useMutation({
    mutationFn: () => save({ data: { value } }),
    onSuccess: () => {
      toast.success('Saved — agencies see this on their Platform Billing page')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd', 'payment-instructions'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  return (
    <div className="mb-6 sm:max-w-lg">
      <h2 className="mb-2 text-sm font-semibold">How agencies pay you</h2>
      <Card className="gap-3 p-4">
        <div className="space-y-2">
          <Label htmlFor="agency-pay-instructions">Payment details shown to agencies</Label>
          <Textarea
            id="agency-pay-instructions"
            rows={5}
            maxLength={2000}
            placeholder={'Dutch-Bangla Bank — A/C 123.456.789 (Rush Tracker)\nbKash (merchant): 01XXXXXXXXX\nWrite your agency name in the reference.'}
            value={value}
            disabled={q.isLoading}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Shown on each agency's Platform Billing page, above the "Pay the platform" button.
          </p>
        </div>
        <Button size="sm" disabled={mutation.isPending || q.isLoading || value === (q.data ?? '')} onClick={() => mutation.mutate()}>
          {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </Card>
    </div>
  )
}
