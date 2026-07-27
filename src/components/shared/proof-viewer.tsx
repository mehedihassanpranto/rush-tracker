import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface State {
  loading: boolean
  url: string | null
  error: string | null
  imgFailed: boolean
}

const INITIAL: State = {
  loading: false,
  url: null,
  error: null,
  imgFailed: false,
}

/**
 * View a stored proof reliably. Fetches a fresh short-lived signed URL when
 * opened and shows it inline (image) plus a real "Open in new tab" link.
 *
 * This deliberately avoids `window.open()` after an await — browsers treat that
 * as a popup and block it. A rendered <a target="_blank"> is a genuine user
 * action and never blocked, so the new-tab option always works.
 */
export function ProofViewerDialog({
  open,
  onOpenChange,
  fetchUrl,
  title = 'Proof',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fetchUrl: () => Promise<{ url: string | null }>
  title?: string
}) {
  const [state, setState] = useState<State>(INITIAL)

  useEffect(() => {
    if (!open) {
      setState(INITIAL)
      return
    }
    let cancelled = false
    setState({ ...INITIAL, loading: true })
    fetchUrl()
      .then(({ url }) => {
        if (cancelled) return
        setState({
          loading: false,
          url,
          error: url ? null : 'No proof uploaded yet.',
          imgFailed: false,
        })
      })
      .catch((err) => {
        if (cancelled) return
        setState({
          loading: false,
          url: null,
          error: err instanceof Error ? err.message : 'Failed to load proof',
          imgFailed: false,
        })
      })
    return () => {
      cancelled = true
    }
    // fetchUrl closes over the current target; re-run only when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3 pr-6">
            <span>{title}</span>
            {state.url && (
              <a
                href={state.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-normal text-primary underline-offset-4 hover:underline"
              >
                Open in new tab
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-40 items-center justify-center">
          {state.loading && (
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          )}

          {!state.loading && state.error && (
            <p className="py-8 text-sm text-muted-foreground">{state.error}</p>
          )}

          {!state.loading && state.url && !state.imgFailed && (
            <img
              src={state.url}
              alt="Proof"
              className="max-h-[70vh] w-auto rounded-md object-contain"
              onError={() => setState((s) => ({ ...s, imgFailed: true }))}
            />
          )}

          {!state.loading && state.url && state.imgFailed && (
            <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-muted-foreground">
              <p>This proof can’t be previewed inline (it may be a PDF).</p>
              <a href={state.url} target="_blank" rel="noopener noreferrer">
                <Button variant="outline">
                  <ExternalLink className="size-4" />
                  Open proof in new tab
                </Button>
              </a>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
