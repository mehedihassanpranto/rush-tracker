import type { TelegramRecipientType } from './recipients'

/**
 * The fixed catalog of Telegram event types this app actually raises —
 * isomorphic (no server imports) so it can back both the preferences UI and
 * server-side validation without pulling in `.server.ts` modules.
 *
 * This is NOT a database table on purpose: it's a small, code-shaped list
 * tied directly to the `notifyTelegram({ eventType: '...' })` call sites that
 * raise these events, not agency-editable data — adding a new event type
 * always means writing the call site anyway, so keeping the catalog next to
 * it in code avoids a second place that can drift out of sync.
 *
 * `recipientTypes` is which kind of connected chat can ever receive this
 * event at all — used to show a subscription only the preference toggles
 * that are actually relevant to it, never a checkbox for something that
 * type of chat could never receive in the first place.
 */
export interface TelegramEventType {
  id: string
  label: string
  recipientTypes: Array<TelegramRecipientType>
}

export const TELEGRAM_EVENT_TYPES: Array<TelegramEventType> = [
  {
    id: 'limit_request.created',
    label: 'Client submitted a limit request',
    recipientTypes: ['agency'],
  },
  {
    id: 'limit_request.sent_to_platform',
    label: 'Limit request sent for platform review',
    recipientTypes: ['platform_admin', 'client'],
  },
  {
    id: 'limit_request.approved',
    label: 'Limit request approved',
    recipientTypes: ['client'],
  },
  {
    id: 'limit_request.rejected',
    label: 'Limit request rejected',
    recipientTypes: ['client'],
  },
  {
    id: 'limit_request.platform_approved',
    label: 'Platform approved an escalated limit request',
    recipientTypes: ['agency'],
  },
  {
    id: 'limit_request.platform_rejected',
    label: 'Platform rejected an escalated limit request',
    recipientTypes: ['agency'],
  },
  {
    id: 'account_request.created',
    label: 'Agency requested a new ad account',
    recipientTypes: ['platform_admin'],
  },
  {
    id: 'account_request.fulfilled',
    label: 'Ad account request fulfilled',
    recipientTypes: ['agency'],
  },
  {
    id: 'account_request.rejected',
    label: 'Ad account request declined',
    recipientTypes: ['agency'],
  },
  {
    id: 'ad_account.granted',
    label: 'Pool ad account granted',
    recipientTypes: ['agency'],
  },
  {
    id: 'ad_account.revoked',
    label: 'Pool ad account revoked',
    recipientTypes: ['agency'],
  },
  {
    id: 'payment.submitted',
    label: 'Client submitted a payment',
    recipientTypes: ['agency'],
  },
  {
    id: 'payment.approved',
    label: 'Payment approved',
    recipientTypes: ['client'],
  },
  {
    id: 'payment.rejected',
    label: 'Payment rejected',
    recipientTypes: ['client'],
  },
  {
    id: 'meta.account_disabled',
    label: 'Ad account disabled on Meta',
    recipientTypes: ['agency', 'platform_admin'],
  },
  {
    id: 'meta.low_balance',
    label: 'Ad account low on Meta spend headroom',
    recipientTypes: ['agency', 'platform_admin'],
  },
]

/** Every event type a chat of this recipient type could ever receive. */
export function eventTypesFor(recipientType: TelegramRecipientType): Array<TelegramEventType> {
  return TELEGRAM_EVENT_TYPES.filter((e) => e.recipientTypes.includes(recipientType))
}

export function isKnownEventType(id: string): boolean {
  return TELEGRAM_EVENT_TYPES.some((e) => e.id === id)
}

export function labelForEventType(id: string): string {
  return TELEGRAM_EVENT_TYPES.find((e) => e.id === id)?.label ?? id
}
