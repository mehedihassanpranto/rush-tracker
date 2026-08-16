import { z } from 'zod'

export const fetchMetaAdAccountSchema = z.object({
  external_account_id: z.string().trim().min(1, 'Enter an account ID'),
})

// USD→BDT rate applied to every account in the batch — same bounds as
// ad-account.ts's per-account usd_rate (kept in sync manually; admins can
// edit individual rates after import via the existing Edit dialog).
const usdRate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .gt(0, 'Must be greater than zero')
  .max(100_000, 'Rate is too large')

export const importMetaAdAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        external_account_id: z.string().trim().min(1),
        name: z.string().trim().min(1).max(200),
      }),
    )
    .min(1, 'Select at least one account')
    .max(50, 'Import at most 50 accounts at a time'),
  usd_rate: usdRate,
})

export const applyMetaSpendCapSchema = z.object({
  id: z.uuid(),
})

export const updateMetaSpendCapSchema = z.object({
  id: z.uuid(),
  spend_cap_usd: z.coerce
    .number({ message: 'Enter a valid amount' })
    .gt(0, 'Must be greater than zero')
    .max(1_000_000_000, 'Amount is too large'),
})

export type FetchMetaAdAccountInput = z.infer<typeof fetchMetaAdAccountSchema>
export type ImportMetaAdAccountsInput = z.infer<
  typeof importMetaAdAccountsSchema
>
export type ApplyMetaSpendCapInput = z.infer<typeof applyMetaSpendCapSchema>
export type UpdateMetaSpendCapInput = z.infer<typeof updateMetaSpendCapSchema>
