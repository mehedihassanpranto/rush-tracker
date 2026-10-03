/**
 * A refusal the user caused and can fix — wrong password, wrong code, rate
 * limit, an expired link. The message is shown to them as-is, and the
 * monitoring middleware does NOT log it as a server error (isExpectedError()
 * in src/lib/monitoring/health.ts), so it can't inflate the error digest.
 *
 * Throw a plain Error for anything that means something actually broke.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}
