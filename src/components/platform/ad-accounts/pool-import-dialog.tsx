import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  importPoolAccountsFn,
  listPoolImportCandidatesFn,
} from '@/server/platform/pool.fns'
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
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Adds accounts from the PLATFORM's own Business Portfolio into the pool.
 *
 * The agency-side "Import from Meta" dialog is the same idea against a
 * different portfolio; this one is deliberately separate rather than a shared
 * component with a flag, because they differ in what they create (a pool
 * account with no owner vs. an agency-owned one) and in what they ask for (no
 * USD rate here — a pool account has no client until it is granted and
 * assigned, so there is nothing yet to bill).
 */
export function PoolImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const listCandidates = useServerFn(listPoolImportCandidatesFn)
  const importAccounts = useServerFn(importPoolAccountsFn)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) setSelected(new Set())
  }, [open])

  const {
    data: candidates,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['pool-import-candidates'],
    queryFn: () => listCandidates(),
    enabled: open,
    retry: false,
  })

  const importable = useMemo(
    () => (candidates ?? []).filter((c) => !c.already_linked),
    [candidates],
  )
  const linkedCount = (candidates ?? []).length - importable.length

  const mutation = useMutation({
    mutationFn: () => {
      const chosen = importable.filter((c) => selected.has(c.external_account_id))
      return importAccounts({
        data: {
          accounts: chosen.map((c) => ({
            external_account_id: c.external_account_id,
            name: c.name,
          })),
        },
      })
    },
    onSuccess: (created) => {
      toast.success(
        `Added ${created.length} account(s) to the pool — ungranted until you assign them to an agency`,
      )
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['pool-import-candidates'] })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add accounts to the pool</DialogTitle>
          <DialogDescription>
            Ad accounts in Rush Tracker's own Business Portfolio. Imported
            accounts join the pool ungranted, with a $0 limit and no USD rate —
            grant one to an agency to put it to work.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-40 w-full" />}

        {/* A failed fetch must never fall through to the empty state: "all
            already linked" and "no portfolio configured" look identical there,
            and only the second one has an action to take. */}
        {!isLoading && error && (
          <p className="py-6 text-center text-sm text-danger">
            {error instanceof Error
              ? error.message
              : "Couldn't reach Meta. Try again in a moment."}
          </p>
        )}

        {!isLoading && !error && importable.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing new to add — all {linkedCount} account(s) in the platform
            portfolio are already linked here.
          </p>
        )}

        {!isLoading && !error && importable.length > 0 && (
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
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Add to pool {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
