import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createUsdSourceFn, updateUsdSourceFn } from '@/server/platform/finance.fns'
import { USD_PAYMENT_METHODS } from '@/schemas/platform-finance'
import { Button } from '@/components/ui/button'
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

/** The fields the dialog edits. `payment_method` is null for a source that was
 * created before the column existed. */
export interface EditableSource {
  id: string
  name: string
  payment_method: string | null
}

/**
 * A place the platform buys USD from (S1, S2, …) and how those dollars reach it
 * — Payoneer, PayPal, Wise, Rizon or Binance. One dialog for both jobs: with no
 * `source` it creates one, with a `source` it edits it (which is also how a
 * source that predates the payment method gets one).
 */
export function SourceDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source?: EditableSource | null
}) {
  const queryClient = useQueryClient()
  const createSource = useServerFn(createUsdSourceFn)
  const updateSource = useServerFn(updateUsdSourceFn)
  const editing = !!source

  const [name, setName] = useState('')
  const [method, setMethod] = useState('')

  useEffect(() => {
    if (open) {
      setName(source?.name ?? '')
      // A source with no method yet opens with none chosen — the placeholder
      // asks for a real answer rather than defaulting to the first option.
      setMethod(source?.payment_method ?? '')
    }
  }, [open, source?.id, source?.name, source?.payment_method])

  const mutation = useMutation({
    mutationFn: () => {
      const payload = { name, payment_method: method as (typeof USD_PAYMENT_METHODS)[number] }
      return source
        ? updateSource({ data: { id: source.id, ...payload } })
        : createSource({ data: payload })
    },
    onSuccess: (saved) => {
      toast.success(editing ? `Source ${saved.name} updated` : `Source ${saved.name} added`)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const valid = name.trim().length > 0 && method !== ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit USD source' : 'New USD source'}</DialogTitle>
          <DialogDescription>
            Where the platform buys dollars from, and the channel those dollars
            arrive through. Names are unique regardless of capitals.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !mutation.isPending) mutation.mutate()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="usd-source-name">Name</Label>
            <Input
              id="usd-source-name"
              value={name}
              maxLength={60}
              placeholder="S1"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="usd-source-method">Payment method (USD)</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="usd-source-method">
                <SelectValue placeholder="Choose a method" />
              </SelectTrigger>
              <SelectContent>
                {USD_PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {editing ? 'Save changes' : 'Add source'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
