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

/** Assumption 4 (DEFAULT). What the supplier's BDT price is per:
 *  - 'net'   — USD that actually landed. A USD fee YOU bear is then a real
 *              extra cost and is capitalized on top of the principal.
 *  - 'gross' — USD the supplier sent. Fees on the USD leg are already inside
 *              the principal; capitalizing them again would double-count. */
export const PRICING_BASIS: 'net' | 'gross' = 'net'

/** Assumption 5 (DEFAULT). Fees you bear go into the batch's acquisition cost
 * and nowhere else — never a second operating-expense line. */
export const CAPITALIZE_BORNE_FEES = true

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
