import { z } from 'zod'

export const fetchMetaAdAccountSchema = z.object({
  external_account_id: z.string().trim().min(1, 'Enter an account ID'),
})

// USD→BDT rate applied to every account in the batch — same bounds as
// ad-account.ts's per-account usd_rate (kept in sync manually; admins can
// edit individual rates after import via the existing Edit dialog).
// Optional: 0/blank means every imported account inherits whichever
// client it's later assigned to, rather than being pinned to a fixed rate
// typed in at import time (see the matching comment in ad-account.ts —
// this bulk path used to force the same unreachable-fallback bug onto
// every account in a batch at once).
const usdRate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .min(0, 'Cannot be negative')
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

/** Pool import: same account list, but no usd_rate. A pool account has no
 * client and no billing relationship until an agency is granted it and assigns
 * it, and the rate that governs billing is resolved then (the account's own
 * rate falling back to the client's — see rate.service.ts). Setting one at
 * import would pin every pool account to a number chosen by the platform, for
 * agencies whose clients it knows nothing about. */
export const importPoolAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        external_account_id: z.string().trim().min(1),
        name: z.string().trim().min(1).max(200),
      }),
    )
    .min(1, 'Select at least one account')
    .max(50, 'Import at most 50 accounts at a time'),
})

export const applyMetaSpendCapSchema = z.object({
  id: z.uuid(),
})

export const updateMetaSpendCapSchema = z.object({
  id: z.uuid(),
  // The increase itself, not the resulting absolute cap — the server
  // computes the new cap from Meta's live spend_cap at write time (never
  // trusts a client-computed absolute number, and can't be raced by a
  // stale dialog baseline; see updateMetaSpendCapFn).
  increase_by_usd: z.coerce
    .number({ message: 'Enter a valid amount' })
    .gt(0, 'Must be greater than zero')
    .max(1_000_000_000, 'Amount is too large'),
})

export const retryMetaSpendCapSyncSchema = z.object({
  id: z.uuid(),
})

export const syncAdAccountNameSchema = z.object({
  id: z.uuid(),
  // The caller already fetched this live (fetchMetaAdAccountFn /
  // listMetaBusinessAdAccountsFn) — passed through rather than
  // re-fetched here to avoid a redundant Graph API call. No worse a trust
  // boundary than the existing manual "Rename" dialog, which lets an admin
  // set an arbitrary name outright with zero Meta verification at all.
  meta_name: z.string().trim().min(1),
})

export type FetchMetaAdAccountInput = z.infer<typeof fetchMetaAdAccountSchema>
export type ImportMetaAdAccountsInput = z.infer<
  typeof importMetaAdAccountsSchema
>
export type ImportPoolAccountsInput = z.infer<typeof importPoolAccountsSchema>
export type ApplyMetaSpendCapInput = z.infer<typeof applyMetaSpendCapSchema>
export type UpdateMetaSpendCapInput = z.infer<typeof updateMetaSpendCapSchema>
export type RetryMetaSpendCapSyncInput = z.infer<
  typeof retryMetaSpendCapSyncSchema
>
export type SyncAdAccountNameInput = z.infer<typeof syncAdAccountNameSchema>
