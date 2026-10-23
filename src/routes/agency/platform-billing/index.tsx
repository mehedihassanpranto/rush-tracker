import { useEffect, useRef, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Download, Loader2, Paperclip, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  cancelPlatformPaymentFn,
  getMyPaymentProofUrlFn,
  getMyPlatformBillFn,
  getMyPlatformStatementFn,
  listMyPlatformChargesFn,
  listMyPlatformPaymentsFn,
  submitPlatformPaymentFn,
} from '@/server/agency-billing/platform-bill.fns'
import { ALLOWED_PROOF_MIME, MAX_PROOF_BYTES } from '@/schemas/limit-request'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { downloadCsv } from '@/lib/csv/csv'
import { fileToBase64, formatFileSize } from '@/lib/utils/file'
import { fmtDateTime, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
import type { MyPlatformPayment } from '@/server/agency-billing/platform-bill.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

/**
 * What this agency owes the platform for limits approved on the platform's
 * pool accounts, and paying it (migrations 000064, 000066). SUPER_ADMIN only
 * (owner's rule): the route redirects other admins; every server fn re-checks.
 */
export const Route = createFileRoute('/agency/platform-billing/')({
  beforeLoad: ({ context }) => {
    if (context.user?.role !== 'SUPER_ADMIN') throw redirect({ to: '/agency' })
  },
  component: PlatformBillingPage,
})

const STATUS_BADGE: Record<MyPlatformPayment['status'], string> = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  REVERSED: 'REVERSED',
}
const STATUS_LABEL: Record<MyPlatformPayment['status'], string> = {
  PENDING: 'Under review',
  APPROVED: 'Accepted',
  REJECTED: 'Not accepted',
  CANCELLED: 'Withdrawn',
  REVERSED: 'Reversed',
}

function PlatformBillingPage() {
  const queryClient = useQueryClient()
  const getBill = useServerFn(getMyPlatformBillFn)
  const listCharges = useServerFn(listMyPlatformChargesFn)
  const listPayments = useServerFn(listMyPlatformPaymentsFn)
  const getStatement = useServerFn(getMyPlatformStatementFn)
  const getProof = useServerFn(getMyPaymentProofUrlFn)
  const cancel = useServerFn(cancelPlatformPaymentFn)
  const [payOpen, setPayOpen] = useState(false)

  const bill = useQuery({ queryKey: ['platform-bill', 'summary'], queryFn: () => getBill() })
  const charges = useQuery({ queryKey: ['platform-bill', 'charges'], queryFn: () => listCharges() })
  const payments = useQuery({ queryKey: ['platform-bill', 'payments'], queryFn: () => listPayments() })
  const b = bill.data

  const statement = useMutation({
    mutationFn: () => getStatement(),
    onSuccess: (st) => {
      downloadCsv(`platform-statement-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })}.csv`, st.rows, [
        { header: 'Date', value: (r) => new Date(r.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) },
        { header: 'Reference', value: (r) => r.reference },
        { header: 'Description', value: (r) => r.description },
        { header: 'USD', value: (r) => r.usd ?? '' },
        { header: 'Rate (BDT/USD)', value: (r) => r.rate ?? '' },
        { header: 'Billed (BDT)', value: (r) => r.billed_bdt ?? '' },
        { header: 'Paid (BDT)', value: (r) => r.paid_bdt ?? '' },
        { header: 'Balance (BDT)', value: (r) => r.balance_bdt },
      ])
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const proof = useMutation({
    mutationFn: (id: string) => getProof({ data: { id } }),
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const withdraw = useMutation({
    mutationFn: (id: string) => cancel({ data: { id } }),
    onSuccess: () => {
      toast.success('Payment withdrawn')
      void queryClient.invalidateQueries({ queryKey: ['platform-bill'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <div className="space-y-6">
      <PageHeader title="Platform Billing" description="What your agency owes Rush Tracker for limits on the platform's ad accounts, and paying it.">
        <Button variant="outline" disabled={statement.isPending} onClick={() => statement.mutate()}>
          <Download className="size-4" />
          Statement
        </Button>
        <Button onClick={() => setPayOpen(true)}>
          <Plus className="size-4" />
          Pay the platform
        </Button>
      </PageHeader>

      {!!bill.error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>Couldn't load your bill</AlertTitle>
          <AlertDescription>{bill.error instanceof Error ? bill.error.message : 'unknown error'}</AlertDescription>
        </Alert>
      )}
      {b && b.pending_rate_count > 0 && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Approvals waiting to be priced</AlertTitle>
          <AlertDescription>
            {b.pending_rate_count} approval{b.pending_rate_count === 1 ? '' : 's'} ({formatUsd(b.pending_rate_usd)}) will be added
            to your bill once the platform sets your rate.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="You owe" hint="Billed − paid" value={b ? formatBdt(b.owed_bdt) : undefined} loading={bill.isLoading} highlight />
        <StatCard label="Credit with the platform" hint="Paid ahead; used by your next approvals" value={b ? formatBdt(b.advance_bdt) : undefined} loading={bill.isLoading} />
        <StatCard label="Your rate" hint="BDT per USD of limit" value={b ? (b.current_rate ? `৳${b.current_rate}` : 'Not set yet') : undefined} loading={bill.isLoading} />
        <StatCard
          label="Under review"
          hint={b && b.pending_payments_count ? `${b.pending_payments_count} payment${b.pending_payments_count === 1 ? '' : 's'}` : 'Payments being checked'}
          value={b ? formatBdt(b.pending_payments_bdt) : undefined}
          loading={bill.isLoading}
        />
      </div>

      <Card className="gap-1 p-4 text-sm">
        <div className="font-medium">How to pay</div>
        {b?.instructions ? (
          <p className="whitespace-pre-wrap text-muted-foreground">{b.instructions}</p>
        ) : (
          <p className="text-muted-foreground">Ask the platform where to send payment. Then record it here with a screenshot of the transfer.</p>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your payments</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paid</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.isLoading && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {payments.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No payments yet.
                  </TableCell>
                </TableRow>
              )}
              {payments.data?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(p.at)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="num">{p.reference_id}</span>
                    <div className="text-xs text-muted-foreground">
                      {[p.method, p.external_reference, p.source === 'RECORDED_BY_PLATFORM' ? 'recorded by the platform' : null].filter(Boolean).join(' · ')}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">
                    {formatBdt(p.approved_bdt ?? p.bdt_amount)}
                    {p.approved_bdt && <div className="text-xs text-muted-foreground line-through">{formatBdt(p.bdt_amount)}</div>}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <StatusBadge status={STATUS_BADGE[p.status]} label={STATUS_LABEL[p.status]} />
                    {p.rejection_reason && <div className="mt-1 text-xs text-muted-foreground">{p.rejection_reason}</div>}
                    {p.status === 'APPROVED' && p.advance_bdt && dec(p.advance_bdt).gt(0) && (
                      <div className="mt-1 text-xs text-muted-foreground">{formatBdt(p.advance_bdt)} kept as credit</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {p.has_proof && (
                        <Button size="sm" variant="ghost" disabled={proof.isPending} onClick={() => proof.mutate(p.id)}>
                          <Paperclip className="size-4" />
                          Proof
                        </Button>
                      )}
                      {p.status === 'PENDING' && (
                        <Button size="sm" variant="outline" disabled={withdraw.isPending} onClick={() => withdraw.mutate(p.id)}>
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">What you were billed</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Approved</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">BDT</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {charges.isLoading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {charges.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing billed yet. Each limit approved on a platform ad account appears here.
                  </TableCell>
                </TableRow>
              )}
              {charges.data?.map((c) => (
                <TableRow key={c.id} className={c.status === 'REVERSED' ? 'opacity-60' : undefined}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(c.at)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {c.kind === 'OPENING_BALANCE' ? (
                      'Opening balance'
                    ) : (
                      <>
                        <span className="num">{c.request_number ?? c.reference_id}</span>
                        {c.ad_account && (
                          <div className="text-xs text-muted-foreground">
                            {c.ad_account.account_code} · {c.ad_account.name}
                          </div>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{c.usd_amount ? formatUsd(c.usd_amount) : '—'}</TableCell>
                  <TableCell className="num text-right">{c.rate ? `৳${c.rate}` : '—'}</TableCell>
                  <TableCell className="num text-right font-medium">{c.bdt_amount ? formatBdt(c.bdt_amount) : '—'}</TableCell>
                  <TableCell className="whitespace-normal">
                    <StatusBadge
                      status={c.status === 'PENDING_RATE' ? 'PENDING' : c.status === 'POSTED' ? 'APPROVED' : 'REVERSED'}
                      label={c.status === 'PENDING_RATE' ? 'Waiting for your rate' : c.status === 'POSTED' ? 'Billed' : 'Reversed'}
                    />
                    {c.reversal_reason && <div className="mt-1 text-xs text-muted-foreground">{c.reversal_reason}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <PayPlatformDialog open={payOpen} onOpenChange={setPayOpen} owed={b?.owed_bdt ?? null} />
    </div>
  )
}

function PayPlatformDialog({ open, onOpenChange, owed }: { open: boolean; onOpenChange: (o: boolean) => void; owed: string | null }) {
  const queryClient = useQueryClient()
  const submit = useServerFn(submitPlatformPaymentFn)
  const fileRef = useRef<HTMLInputElement>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [key, setKey] = useState('')

  useEffect(() => {
    if (open) {
      setAmount('')
      setMethod('')
      setReference('')
      setWhen(nowLocalInput())
      setNote('')
      setFile(null)
      setKey(crypto.randomUUID())
    }
  }, [open])

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (!ALLOWED_PROOF_MIME.includes(f.type as never)) {
      toast.error('Use JPG, PNG, WEBP or PDF')
      return
    }
    if (f.size > MAX_PROOF_BYTES) {
      toast.error('File must be 3 MB or smaller')
      return
    }
    setFile(f)
  }

  const valid = amount !== '' && Number(amount) > 0 && method.trim() !== '' && when !== '' && file !== null
  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Attach a proof')
      return submit({
        data: {
          bdt_amount: Number(amount),
          method,
          external_reference: reference || undefined,
          paid_at: localInputToIso(when),
          note: note || undefined,
          idempotency_key: key,
          file_name: file.name,
          mime_type: file.type as (typeof ALLOWED_PROOF_MIME)[number],
          data_base64: await fileToBase64(file),
        },
      })
    },
    onSuccess: (r) => {
      toast.success(r.duplicate ? 'Already submitted' : `Sent for review (${r.reference_id})`)
      void queryClient.invalidateQueries({ queryKey: ['platform-bill'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pay the platform</DialogTitle>
          <DialogDescription>
            Record a payment you sent to Rush Tracker, with a screenshot of the transfer. The platform checks it and
            adds it to your account; anything beyond what you owe is kept as credit.
            {owed && dec(owed).gt(0) && ` You owe ${formatBdt(owed)}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pp-amount">Amount (BDT)</Label>
              <Input id="pp-amount" type="number" min="0" step="0.01" inputMode="decimal" placeholder="Enter amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pp-when">Paid on</Label>
              <Input id="pp-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pp-method">Paid by</Label>
              <Input id="pp-method" list="pp-methods" maxLength={100} placeholder="DBBL transfer, bKash…" value={method} onChange={(e) => setMethod(e.target.value)} />
              <datalist id="pp-methods">
                {['DBBL transfer', 'NPSB transfer', 'bKash', 'Nagad', 'Cash'].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pp-ref">Transaction ID (optional)</Label>
              <Input id="pp-ref" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pp-note">Note (optional)</Label>
            <Textarea id="pp-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Proof</Label>
            <div className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" aria-label="Proof file" onChange={onPickFile} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-4" />
                {file ? 'Change file' : 'Attach screenshot'}
              </Button>
              {file && (
                <span className="text-sm text-muted-foreground">
                  {file.name} · {formatFileSize(file.size)}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">JPG, PNG, WEBP or PDF, up to 3 MB. Required.</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Submit payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
