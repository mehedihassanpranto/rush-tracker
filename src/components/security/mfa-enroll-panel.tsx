import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, ShieldCheck } from 'lucide-react'

import { confirmMfaEnrollFn, startMfaEnrollFn } from '@/server/auth/mfa.fns'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Set up an authenticator app: scan the QR code (or type the key), then enter
 * the first code. Used by the mandatory setup page and the Security page.
 */
export function MfaEnrollPanel({ onDone }: { onDone: () => void | Promise<void> }) {
  const start = useServerFn(startMfaEnrollFn)
  const confirm = useServerFn(confirmMfaEnrollFn)
  const [code, setCode] = useState('')

  const enroll = useMutation({ mutationFn: () => start() })
  const verify = useMutation({
    mutationFn: () => confirm({ data: { factor_id: enroll.data!.factor_id, code } }),
    onSuccess: () => onDone(),
  })

  if (!enroll.data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          You'll need an authenticator app on your phone — Google Authenticator,
          Microsoft Authenticator, Authy or 1Password all work.
        </p>
        {enroll.error && (
          <Alert variant="destructive">
            <AlertDescription>{(enroll.error as Error).message}</AlertDescription>
          </Alert>
        )}
        <Button onClick={() => enroll.mutate()} disabled={enroll.isPending}>
          {enroll.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          Set up authenticator app
        </Button>
      </div>
    )
  }

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        verify.mutate()
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Open your authenticator app and add a new account.</li>
        <li>Scan this QR code, or enter the key below.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      <div className="flex justify-center rounded-md bg-white p-3">
        <img src={enroll.data.qr_code} alt="QR code for your authenticator app" className="size-44" />
      </div>
      <div className="space-y-1">
        <Label>Key (if you can't scan)</Label>
        <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">
          {enroll.data.secret}
        </code>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mfa-setup-code">6-digit code</Label>
        <Input
          id="mfa-setup-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
      </div>
      {verify.error && (
        <Alert variant="destructive">
          <AlertDescription>{(verify.error as Error).message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={code.length !== 6 || verify.isPending}>
        {verify.isPending && <Loader2 className="size-4 animate-spin" />}
        Verify and turn on
      </Button>
    </form>
  )
}
