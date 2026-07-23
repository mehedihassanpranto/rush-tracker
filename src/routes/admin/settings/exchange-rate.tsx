import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  getDefaultRateFn,
  listRateHistoryFn,
  setDefaultRateFn,
} from '@/server/exchange-rates/exchange-rate.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/admin/settings/exchange-rate')({
  component: ExchangeRatePage,
})

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ExchangeRatePage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.EXCHANGE_RATE_MANAGE)

  const queryClient = useQueryClient()
  const getRate = useServerFn(getDefaultRateFn)
  const listHistory = useServerFn(listRateHistoryFn)
  const setRate = useServerFn(setDefaultRateFn)
  const [newRate, setNewRate] = useState('')

  const { data: current, isLoading } = useQuery({
    queryKey: ['default-rate'],
    queryFn: () => getRate(),
  })

  const { data: history } = useQuery({
    queryKey: ['rate-history'],
    queryFn: () => listHistory(),
    enabled: canManage,
  })

  const mutation = useMutation({
    mutationFn: () => setRate({ data: { rate: Number(newRate) } }),
    onSuccess: () => {
      toast.success('Default rate updated')
      setNewRate('')
      void queryClient.invalidateQueries({ queryKey: ['default-rate'] })
      void queryClient.invalidateQueries({ queryKey: ['rate-history'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rateNum = Number(newRate)
  const valid = newRate !== '' && Number.isFinite(rateNum) && rateNum > 0

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/admin/settings"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Settings
      </Link>

      <PageHeader
        title="Exchange rate"
        description="The default USD→BDT rate prefilled during limit approvals."
      />

      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Current default rate</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-9 w-24" />
          ) : (
            <div className="text-3xl font-semibold">৳{current?.rate}</div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Changing this only affects future approvals. Past approvals keep the
            rate that was applied at the time.
          </p>
        </CardContent>
      </Card>

      {canManage ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Set a new rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-3">
              <div className="space-y-2">
                <Label>New rate (BDT per USD)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  className="w-40"
                  value={newRate}
                  onChange={(e) => setNewRate(e.target.value)}
                />
              </div>
              <Button
                disabled={!valid || mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
                Update rate
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Alert className="mb-4">
          <AlertDescription>
            You don&apos;t have permission to change the default rate.
          </AlertDescription>
        </Alert>
      )}

      {canManage && (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rate</TableHead>
                <TableHead>Effective from</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">৳{r.rate}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {fmtDateTime(r.effective_from)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
