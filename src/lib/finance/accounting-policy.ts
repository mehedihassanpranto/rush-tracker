/**
 * Finance v2 accounting policy, as code — the single place the plan's
 * defaults live (docs/ACCOUNTING_POLICY.md is the prose version; keep the two
 * in step). Values marked DEFAULT are the plan's assumptions (plan v2,
 * Assumptions 4–11), all accepted by the owner on 2026-10-20. Changing one
 * here (and the matching SQL in post_usd_purchase(), migration 000059) is
 * meant to be the whole change.
 *
 * Pure constants, no imports, so both the fee/FIFO libraries and their tests
 * read the same values.
 */

/* Assumptions 4 and 5 (confirmed) need no switch: the supplier prices on
 * net USD, and a batch costs exactly the taka that left your accounts
 * (principal + the bank fee you bear) — see usd-batch.ts for why a USD fee is
 * never added on top. */

/** Assumption 8 (DEFAULT). A purchase dated before a batch that has already
 * been consumed is refused (FIFO follows posting order). */
export const BLOCK_BACKDATED_PURCHASES = true

/** Supplier-rate sanity band, BDT per USD. Outside it is a soft warning only. */
export const SUPPLIER_RATE_WARN_MIN = '124'
export const SUPPLIER_RATE_WARN_MAX = '131'

/** Decimal places. USD is held at 6 internally and shown at 2; BDT at 2;
 * rates at 6. */
export const USD_DP = 6
export const BDT_DP = 2
export const RATE_DP = 6
