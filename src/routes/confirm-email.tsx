import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { AlertCircle, CheckCircle2, Loader2, MailCheck } from 'lucide-react'

import { confirmEmailChangeFn } from '@/server/auth/email-change.fns'
import { StandaloneLayout } from '@/components/security/standalone-layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * Where the email-change confirmation links land. Public (the link is often
 * opened on a phone that isn't signed in) and deliberately does nothing until
 * the button is pressed: mail scanners open links to check them, and an
 * auto-confirming page would let them use up the single-use token.
 */
export const Route = createFileRoute('/confirm-email')({
  validateSearch: (search: Record<string, unknown>): { token_hash: string } => ({
    token_hash: typeof search.token_hash === 'string' ? search.token_hash : '',
  }),
  component: ConfirmEmailPage,
})

function ConfirmEmailPage() {
  const router = useRouter()
  const { token_hash } = Route.useSearch()
  const confirm = useServerFn(confirmEmailChangeFn)
  const mutation = useMutation({
    mutationFn: () => confirm({ data: { token_hash } }),
    // A signed-in viewer's header should show the new address at once.
    onSuccess: (r) => (r.status === 'done' ? router.invalidate() : undefined),
  })
  const result = mutation.data

  return (
    <StandaloneLayout>
      <Card>
        <CardHeader>
          <CardTitle>Confirm email change</CardTitle>
          <CardDescription>
            Your sign-in email changes only after the links sent to both your
            current and your new address are confirmed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!token_hash && <LinkProblem message="This link is incomplete. Open it again from the email." />}

          {token_hash && !result && (
            <>
              {mutation.error ? (
                <>
                  <LinkProblem
                    message={mutation.error instanceof Error ? mutation.error.message : 'Something went wrong'}
                  />
                  <Button asChild variant="outline" className="w-full">
                    <Link to="/">Go to Rush Tracker</Link>
                  </Button>
                </>
              ) : (
                <Button className="w-full" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                  {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
                  Confirm
                </Button>
              )}
            </>
          )}

          {result?.status === 'partial' && (
            <Alert>
              <MailCheck className="size-4" />
              <AlertDescription>
                Confirmed. One more step: open the link we sent to your other
                email address. Your sign-in email changes once both are confirmed.
              </AlertDescription>
            </Alert>
          )}

          {result?.status === 'done' && (
            <>
              <Alert>
                <CheckCircle2 className="size-4 text-emerald-600" />
                <AlertDescription>
                  Done. Your sign-in email is now <strong>{result.email}</strong>.
                  Use it the next time you sign in.
                </AlertDescription>
              </Alert>
              <Button asChild variant="outline" className="w-full">
                <Link to="/">Continue</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </StandaloneLayout>
  )
}

function LinkProblem({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
