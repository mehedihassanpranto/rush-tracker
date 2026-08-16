import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  importMetaAdAccountsFn,
  listMetaBusinessAdAccountsFn,
} from '@/server/meta/meta.fns'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

export function MetaImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const listCandidates = useServerFn(listMetaBusinessAdAccountsFn)
  const importAccounts = useServerFn(importMetaAdAccountsFn)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rate, setRate] = useState('')

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setRate('')
    }
  }, [open])

  const { data: candidates, isLoading } = useQuery({
    queryKey: ['meta-business-ad-accounts'],
    queryFn: () => listCandidates(),
    enabled: open,
  })

  const importable = useMemo(
    () => (candidates ?? []).filter((c) => !c.already_linked),
    [candidates],
  )

  const mutation = useMutation({
    mutationFn: () => {
      const chosen = importable.filter((c) =>
        selected.has(c.external_account_id),
      )
      return importAccounts({
        data: {
          accounts: chosen.map((c) => ({
            external_account_id: c.external_account_id,
            name: c.name,
          })),
          usd_rate: Number(rate),
        },
      })
    },
    onSuccess: (created) => {
      toast.success(`Imported ${created.length} account(s) from Meta`)
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Import failed'),
  })

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rateValid = Number(rate) > 0
  const canSubmit = selected.size > 0 && rateValid && !mutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from Meta</DialogTitle>
          <DialogDescription>
            Ad accounts owned by your Business Portfolio. Imported accounts
            start unassigned with a $0 limit — set the real limit through the
            normal limit-request flow.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-40 w-full" />}

        {!isLoading && importable.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No new accounts to import — everything in the Business Portfolio
            is already linked.
          </p>
        )}

        {!isLoading && importable.length > 0 && (
          <>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
              {importable.map((c) => (
                <label
                  key={c.external_account_id}
                  className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selected.has(c.external_account_id)}
                    onCheckedChange={() => toggle(c.external_account_id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.external_account_id} · {c.meta_status_label}
                      {c.currency ? ` · ${c.currency}` : ''}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <Label>Default rate for imported accounts (BDT per $1)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="130.00"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Import {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
