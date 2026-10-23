import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  getOpeningBankFn,
  listReconciliationsFn,
  recordOpeningBankFn,
  recordReconciliationFn,
  resolveReconciliationFn,
  reverseOpeningBankFn,
} from '@/server/platform/finance-close.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
import { ReverseDialog } from '@/components/platform/finance/inventory-dialogs'
import type { ReconciliationRow } from '@/server/platform/finance-close.fns'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

const DEFAULT_WALLETS = ['Binance', 'Payoneer']
const fmt = (row: ReconciliationRow, v: string) => (row.currency === 'USD' ? formatUsd(v) : formatBdt(v))

/**
 * Finance v2 Milestone 5 (migration 000065): your real balances against the
 * books. A difference over ৳1 / $1 is kept open until someone says what
 * explains it — and is fixed by a real entry (a purchase or payout not yet
 * recorded), never by this page. Also where the bank's go-live balance is
 * entered once, so "Bank & cash" in the journal is your real balance.
 */
export function ReconcileTab() {
  const queryClient = useQueryClient()
  const list = useServerFn(listReconciliationsFn)
  const record = useServerFn(recordReconciliationFn)
  const resolve = useServerFn(resolveReconciliationFn)
  const getOpening = useServerFn(getOpeningBankFn)
  const setOpening = useServerFn(recordOpeningBankFn)
  const undoOpening = useServerFn(reverseOpeningBankFn)

  const [wallets, setWallets] = useState(DEFAULT_WALLETS.map((w) => ({ wallet: w, usd: '' })))
  const [walletNote, setWalletNote] = useState('')
  const [bank, setBank] = useState('')
  const [bankWhen, setBankWhen] = useState(nowLocalInput())
  const [openBdt, setOpenBdt] = useState('')
  const [openWhen, setOpenWhen] = useState(nowLocalInput())
  const [openNotes, setOpenNotes] = useState('')
  const [resolving, setResolving] = useState<ReconciliationRow | null>(null)
  const [undoing, setUndoing] = useState(false)

  const history = useQuery({ queryKey: ['platform-usd', 'reconciliations'], queryFn: () => list() })
  const opening = useQuery({ queryKey: ['platform-usd', 'opening-bank'], queryFn: () => getOpening() })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
  const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : 'Failed')
  const said = (s: string) =>
    toast[s === 'MATCHED' ? 'success' : 'warning'](s === 'MATCHED' ? 'Matches the books' : 'Recorded — it differs from the books')

  const walletsOk = wallets.every((w) => w.wallet.trim() !== '' && w.usd !== '' && Number(w.usd) >= 0)
  const recWallets = useMutation({
    mutationFn: () =>
      record({ data: { scope: 'USD_WALLETS', wallets: wallets.map((w) => ({ wallet: w.wallet.trim(), usd: Number(w.usd) })), note: walletNote || undefined } }),
    onSuccess: (s) => {
      said(s)
      setWallets(DEFAULT_WALLETS.map((w) => ({ wallet: w, usd: '' })))
      setWalletNote('')
      refresh()
    },
    onError: fail,
  })
  const recBank = useMutation({
    mutationFn: () => record({ data: { scope: 'BANK', bdt: Number(bank), as_of: localInputToIso(bankWhen) } }),
    onSuccess: (s) => {
      said(s)
      setBank('')
      refresh()
    },
    onError: fail,
  })
  const saveOpening = useMutation({
    mutationFn: () => setOpening({ data: { bdt: Number(openBdt), as_of: localInputToIso(openWhen), notes: openNotes } }),
    onSuccess: () => {
      toast.success('Opening bank balance recorded')
      refresh()
    },
    onError: fail,
  })
  const resolveMut = useMutation({
    mutationFn: (v: { id: string; note: string }) => resolve({ data: v }),
    onSuccess: () => {
      setResolving(null)
      toast.success('Resolved')
      refresh()
    },
    onError: fail,
  })
  const undoMut = useMutation({
    mutationFn: (reason: string) => undoOpening({ data: { reason } }),
    onSuccess: () => {
      setUndoing(false)
      toast.success('Opening bank balance reversed')
      refresh()
    },
    onError: fail,
  })

  const total = wallets.reduce((s, w) => s.plus(Number(w.usd) || 0), dec(0))

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 p-4">
          <div>
            <h2 className="font-semibold">USD in your wallets</h2>
            <p className="text-xs text-muted-foreground">Compared with the USD in stock (FIFO), right now.</p>
          </div>
          {wallets.map((w, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                {i === 0 && <Label className="text-xs">Wallet</Label>}
                <Input
                  aria-label={`Wallet ${i + 1} name`}
                  value={w.wallet}
                  maxLength={60}
                  onChange={(e) => setWallets(wallets.map((x, j) => (j === i ? { ...x, wallet: e.target.value } : x)))}
                />
              </div>
              <div className="w-36 space-y-1">
                {i === 0 && <Label className="text-xs">USD</Label>}
                <Input
                  aria-label={`${w.wallet || `Wallet ${i + 1}`} USD`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={w.usd}
                  onChange={(e) => setWallets(wallets.map((x, j) => (j === i ? { ...x, usd: e.target.value } : x)))}
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove wallet"
                disabled={wallets.length === 1}
                onClick={() => setWallets(wallets.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between text-sm">
            <Button size="sm" variant="ghost" onClick={() => setWallets([...wallets, { wallet: '', usd: '' }])}>
              <Plus className="size-4" />
              Add wallet
            </Button>
            <span>
              Total <span className="num font-medium">{formatUsd(total.toFixed(2))}</span>
            </span>
          </div>
          <Input aria-label="Wallet note" placeholder="Note (optional)" value={walletNote} maxLength={500} onChange={(e) => setWalletNote(e.target.value)} />
          <Button className="w-full" disabled={!walletsOk || recWallets.isPending} onClick={() => recWallets.mutate()}>
            {recWallets.isPending && <Loader2 className="size-4 animate-spin" />}
            Check against the books
          </Button>
        </Card>

        <div className="space-y-4">
          <Card className="gap-3 p-4">
            <div>
              <h2 className="font-semibold">Bank balance</h2>
              <p className="text-xs text-muted-foreground">
                Compared with "Bank & cash" in the journal at that moment.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="rec-bank" className="text-xs">BDT (all bank accounts)</Label>
                <Input id="rec-bank" type="number" step="0.01" inputMode="decimal" value={bank} onChange={(e) => setBank(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rec-bank-when" className="text-xs">As of</Label>
                <Input id="rec-bank-when" type="datetime-local" value={bankWhen} onChange={(e) => setBankWhen(e.target.value)} />
              </div>
            </div>
            <Button className="w-full" disabled={bank === '' || recBank.isPending} onClick={() => recBank.mutate()}>
              {recBank.isPending && <Loader2 className="size-4 animate-spin" />}
              Check against the books
            </Button>
          </Card>

          <Card className="gap-3 p-4">
            <div>
              <h2 className="font-semibold">Opening bank balance</h2>
              <p className="text-xs text-muted-foreground">
                Your bank balance at go-live, entered once. Until then "Bank & cash" only shows movement since
                Finance v2.
              </p>
            </div>
            {opening.data ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="num font-medium">{formatBdt(opening.data.bdt_amount)}</span> as of{' '}
                  {fmtDateTime(opening.data.as_of)} · {opening.data.notes}
                </span>
                <Button size="sm" variant="outline" onClick={() => setUndoing(true)}>
                  Reverse
                </Button>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="open-bank" className="text-xs">BDT (negative if overdrawn)</Label>
                    <Input id="open-bank" type="number" step="0.01" inputMode="decimal" value={openBdt} onChange={(e) => setOpenBdt(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="open-bank-when" className="text-xs">As of</Label>
                    <Input id="open-bank-when" type="datetime-local" value={openWhen} onChange={(e) => setOpenWhen(e.target.value)} />
                  </div>
                </div>
                <Textarea aria-label="Opening bank evidence" rows={2} maxLength={500} placeholder="DBBL statement 20 Oct: 412,300 …" value={openNotes} onChange={(e) => setOpenNotes(e.target.value)} />
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={openBdt === '' || Number(openBdt) === 0 || openNotes.trim() === '' || saveOpening.isPending}
                  onClick={() => saveOpening.mutate()}
                >
                  {saveOpening.isPending && <Loader2 className="size-4 animate-spin" />}
                  Record opening balance
                </Button>
              </>
            )}
          </Card>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">History</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">Books</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing reconciled yet.
                  </TableCell>
                </TableRow>
              )}
              {history.data?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.as_of)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.scope === 'USD_WALLETS' ? 'Wallets' : 'Bank'}
                    <div className="text-xs text-muted-foreground">
                      {r.details.map((d) => `${d.wallet} ${formatUsd(String(d.usd))}`).join(' · ')}
                      {r.note && ` ${r.note}`}
                      {r.resolution_note && ` · Resolved: ${r.resolution_note}`}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">{fmt(r, r.expected)}</TableCell>
                  <TableCell className="num text-right">{fmt(r, r.actual)}</TableCell>
                  <TableCell className={`num text-right font-medium ${r.status === 'DIFFERENCE' ? 'text-warning' : ''}`}>
                    {fmt(r, r.difference)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status === 'MATCHED' ? 'APPROVED' : r.status === 'RESOLVED' ? 'COMPLETED' : 'PENDING'} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === 'DIFFERENCE' && (
                      <Button size="sm" variant="outline" onClick={() => setResolving(r)}>
                        Resolve
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Within ৳1 / $1 counts as matching. A difference is usually a purchase, payout or payment not recorded
          yet — record it, then check again, and resolve the old one with what it was.
        </p>
      </div>

      <ReverseDialog
        target={
          resolving
            ? {
                title: 'Resolve the difference',
                description: `${fmt(resolving, resolving.difference)} between the books and the actual balance. Say what explains it.`,
                confirmLabel: 'Resolve',
              }
            : null
        }
        onOpenChange={(o) => !o && setResolving(null)}
        onConfirm={(note) => resolving && resolveMut.mutate({ id: resolving.id, note })}
        pending={resolveMut.isPending}
      />
      <ReverseDialog
        target={undoing ? { title: 'Reverse the opening bank balance', description: 'A mirror entry is posted; you can then enter it again.' } : null}
        onOpenChange={(o) => !o && setUndoing(false)}
        onConfirm={(reason) => undoMut.mutate(reason)}
        pending={undoMut.isPending}
      />
    </>
  )
}
