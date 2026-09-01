import { z } from 'zod'

const rate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .positive('Must be greater than zero')
  .max(1_000, 'Rate is too large')

const usdAmount = z.coerce
  .number({ message: 'Enter a valid amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000, 'Amount is too large')

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date')

export const usdMarginEntryCreateSchema = z.object({
  transaction_date: isoDate,
  usd_amount: usdAmount,
  buying_rate: rate,
  selling_rate: rate,
})

export type UsdMarginEntryCreateInput = z.infer<typeof usdMarginEntryCreateSchema>
