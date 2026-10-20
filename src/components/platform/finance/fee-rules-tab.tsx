import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { createFeeRuleFn, endFeeRuleFn, listFeeRulesFn } from '@/server/platform/usd-inventory.fns'
import { BANK_INSTITUTIONS, FEE_CHANNELS, FEE_CHANNEL_LABELS, bankName } from '@/schemas/usd-inventory'
import { formatBdt, formatUsd } from '@/lib/money/money'
import type { FeeRuleRow } from '@/server/platform/usd-inventory.fns'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ANY = '*'
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

function institution(code: string): string {
  return code === ANY ? 'Any' : bankName(code)
}

function feeText(r: FeeRuleRow): string {
  if (r.fee_type === 'PERCENT') return `${r.percent}%`
  const amount = r.amount ?? '0'
  return r.currency === 'USD' ? formatUsd(amount) : formatBdt(amount)
}

/**
 * Automatic transfer fees (Finance v2). A purchase looks up the rule in force
 * on its date; a fee is snapshotted on the purchase, so ending or adding a
 * rule never changes anything already recorded. Changing a fee = end the old
 * rule, add a new one from the next day.
 */
export function FeeRulesTab() {
  const queryClient = useQueryClient()
  const list = useServerFn(listFeeRulesFn)
  const end = useServerFn(endFeeRuleFn)
  const [addOpen, setAddOpen] = useState(false)

  const rules = useQuery({ queryKey: ['platform-usd', 'fee-rules'], queryFn: () => list() })
  const ending = useMutation({
    mutationFn: (id: string) => end({ data: { id, effective_to: today() } }),
    onSuccess: () => {
      toast.success('Rule ended today')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Fee rules</h2>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          New rule
        </Button>
      </div>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Route</TableHead>
              <TableHead className="text-right">Fee</TableHead>
              <TableHead className="text-right">You bear</TableHead>
              <TableHead>In force</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.isLoading && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!!rules.error && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-destructive">
                  {rules.error instanceof Error ? rules.error.message : 'Could not load'}
                </TableCell>
              </TableRow>
            )}
            {rules.data?.map((r) => {
              const active = !r.effective_to || r.effective_to >= today()
              return (
                <TableRow key={r.id} className={active ? undefined : 'opacity-60'}>
                  <TableCell>
                    <div className="font-medium">{r.code}</div>
                    {r.notes && (
                      <div className="max-w-xs text-xs whitespace-normal text-muted-foreground">{r.notes}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {FEE_CHANNEL_LABELS[r.channel as (typeof FEE_CHANNELS)[number]] ?? r.channel}
                    {(r.channel === 'BANK_INTERNAL' || r.channel === 'NPSB') && (
                      <div className="text-xs text-muted-foreground">
                        {institution(r.from_institution)} → {institution(r.to_institution)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{feeText(r)}</TableCell>
                  <TableCell className="num text-right">{Number(r.your_share_pct)}%</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    <StatusBadge status={active ? 'ACTIVE' : 'INACTIVE'} />
                    <div className="mt-1 text-xs text-muted-foreground">
                      {r.effective_from} → {r.effective_to ?? 'no end'}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {!r.effective_to && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ending.isPending}
                        onClick={() => ending.mutate(r.id)}
                      >
                        End today
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        A purchase whose route has no rule can't be recorded until its fee is entered by
        hand — a missing fee is never treated as zero. Payoneer fees are always entered by
        hand from the statement.
      </p>
      <AddRuleDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

function AddRuleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const create = useServerFn(createFeeRuleFn)
  const [code, setCode] = useState('')
  const [channel, setChannel] = useState<(typeof FEE_CHANNELS)[number]>('NPSB')
  const [from, setFrom] = useState(ANY)
  const [to, setTo] = useState(ANY)
  const [feeType, setFeeType] = useState<'FIXED' | 'PERCENT'>('FIXED')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState<'BDT' | 'USD'>('BDT')
  const [share, setShare] = useState('100')
  const [startDate, setStartDate] = useState(today())

  useEffect(() => {
    if (open) {
      setCode('')
      setChannel('NPSB')
      setFrom(ANY)
      setTo(ANY)
      setFeeType('FIXED')
      setValue('')
      setCurrency('BDT')
      setShare('100')
      setStartDate(today())
    }
  }, [open])

  const isBank = channel === 'BANK_INTERNAL' || channel === 'NPSB'
  const valid = code.trim() !== '' && value !== '' && Number(value) >= 0 && share !== '' && startDate !== ''

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          code,
          channel,
          from_institution: isBank ? from : ANY,
          to_institution: isBank ? (channel === 'BANK_INTERNAL' ? from : to) : ANY,
          fee_type: feeType,
          amount: feeType === 'FIXED' ? Number(value) : undefined,
          percent: feeType === 'PERCENT' ? Number(value) : undefined,
          currency,
          your_share_pct: Number(share),
          effective_from: startDate,
        },
      }),
    onSuccess: () => {
      toast.success('Fee rule added')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const bankSelect = (id: string, v: string, set: (v: string) => void, allowAny: boolean) => (
    <Select value={v} onValueChange={set}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowAny && <SelectItem value={ANY}>Any bank</SelectItem>}
        {BANK_INSTITUTIONS.map((b) => (
          <SelectItem key={b.code} value={b.code}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New fee rule</DialogTitle>
          <DialogDescription>
            Applies to purchases dated on or after its start. A rule naming a bank beats
            one for "any bank".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rule-code">Name</Label>
            <Input id="rule-code" value={code} maxLength={60} placeholder="brac-internal" onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-channel">Route</Label>
            <Select
              value={channel}
              onValueChange={(v) => {
                const c = v as typeof channel
                setChannel(c)
                setCurrency(c === 'BINANCE' || c === 'PAYONEER' ? 'USD' : 'BDT')
                if (c === 'BANK_INTERNAL' && from === ANY) setFrom('DBBL')
              }}
            >
              <SelectTrigger id="rule-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEE_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {FEE_CHANNEL_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isBank && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rule-from">{channel === 'BANK_INTERNAL' ? 'Bank' : 'From'}</Label>
                {bankSelect('rule-from', from, setFrom, channel === 'NPSB')}
              </div>
              {channel === 'NPSB' && (
                <div className="space-y-2">
                  <Label htmlFor="rule-to">To</Label>
                  {bankSelect('rule-to', to, setTo, true)}
                </div>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="rule-type">Type</Label>
              <Select value={feeType} onValueChange={(v) => setFeeType(v as typeof feeType)}>
                <SelectTrigger id="rule-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FIXED">Flat</SelectItem>
                  <SelectItem value="PERCENT">Percent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-value">{feeType === 'FIXED' ? `Fee (${currency})` : 'Percent'}</Label>
              <Input id="rule-value" type="number" min="0" step="0.01" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-share">You bear (%)</Label>
              <Input id="rule-share" type="number" min="0" max="100" step="1" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-from-date">Starts</Label>
            <Input id="rule-from-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
