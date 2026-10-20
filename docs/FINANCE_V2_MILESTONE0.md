# Finance v2 — Milestone 0: schema inspection and mapping

2026-10-20. Input: "Rush Tracker Financial Dashboard: Full Plan v2". The plan
says Milestone 0 maps every entity onto the live schema and **stops for review
before any migration is written**. This is that review. Nothing here changes
the database or the running dashboard.

Delivered with it:
- `docs/ACCOUNTING_POLICY.md`: the rules.
- `src/lib/finance/accounting-policy.ts`: the defaults as constants.
- `fees.ts`, `usd-batch.ts`, `fifo.ts`: the database-free engine (fee rules,
  batch cost, FIFO, prepaid lots, backdating and reversal guards).
- `golden-dataset.ts` + tests: the hand-computed scenario.

Those parts don't depend on any open decision below, except the constants
marked [default].

## 1. What the finance dashboard is today

`/platform/finance` ("Finance & Accounts", platform admins only), migrations
000041–000043:

| Tab | Shows | Built from |
| --- | --- | --- |
| USD Stock | purchased, sold, remaining, BDT invested/received, avg buy/sell rate, stock value, gross BDT difference; today's limit approvals | `usd_stock_summary` view: **weighted-average** cost |
| Source Summary | purchased / allocated / remaining per source, avg buying rate | `computeSourceWiseStock()`: FIFO **derived on the fly**, not stored |
| Agency Summary | per agency: USD sold + USD of approved pool-account limit requests, BDT paid, avg selling rate | `agency_usd_summary`, `agency_limit_approvals_summary` |

Properties worth keeping: zero-policy RLS plus revoked grants plus
`security_invoker` views on every table; no audit rows in `audit_logs`
(org-zero trap); sales audited into the buying agency's log; insert-only.

Gaps against v2: no fees, gross only (no net), weighted-average cost, no
stored allocations, no journal, no Meta prepaid/postpaid, no platform-side
receivables (a sale assumes its BDT arrived), no reversal path ("a wrong row
is fixed in the database"), no periods, no maker-checker.

**Unaffected:** `/agency/finance` (`usd_margin_entries`, an agency's own
spread) and the agency client ledger (`ledger_entries`). v2 is the platform's
book.

## 2. Plan entity → existing table

| Plan entity | Maps to | Change (additive only) |
| --- | --- | --- |
| suppliers | `usd_sources` | add `receiving_institution`, `default_rate`; bank/wallet details in new restricted `usd_source_accounts` |
| fee_rules | — | **new**, effective-dated; seeded from `defaultFeeRules()` |
| usd_batches | `usd_purchases` | add `gross_usd`, `net_usd`, `fees` (snapshot), `capitalized_fees_bdt`, `total_bdt_cost`, `effective_rate`, `posting_seq`, `status`, `external_reference` (unique per source), `reversal_of`. Existing rows backfill as opening batches: gross = net = `usd_amount`, cost = `bdt_amount` |
| inventory_allocations | — (today derived in `usd-stock.ts`) | **new**, insert-only |
| financial_transactions | `usd_sales` covers one type | **new** umbrella (type, event date, posting date, idempotency key per tenant, maker, checker, reversal ref); `usd_sales` rows link to one |
| accounts / journal_entries / journal_lines | — | **new** (Milestone 2) |
| meta_account_settings | `ad_accounts` (+ `meta_*` snapshot columns, 000056) | **new** `meta_billing_mode` + funded lots table. Not `segment`: see §3 |
| client_rates | agency→client: `ad_accounts.usd_rate` / client rate (`adAccountUsdRate()`). Platform→agency: none (rate is per sale) | **new** `agency_usd_rates` if the platform prices agencies per account (Q1) |
| client_payments / payment_allocations | agency side: `payments` + `ledger_entries`. Platform side: none | **new** `agency_payments` (Q1) |
| reconciliation_records | — | **new** |
| audit_events | `audit_logs` is **unusable** (org zero = xRush) | **new** `platform_finance_audit`, no UPDATE/DELETE grants + blocking trigger |

New tables follow migrations 000050–52 (service-role only, zero policies).
Any table with an `organization_id` FK goes into `OFFBOARD_ORDER`; platform
finance rows should survive an agency's deletion the way `usd_sales` does
(`ON DELETE SET NULL` + snapshotted name).

## 3. Traps found while mapping

1. **Two meanings of prepaid/postpaid.** The plan's means Meta's billing mode.
   The app's `client_segment` enum (prepaid/partial/postpaid) means how a
   client pays the agency. The new column is `meta_billing_mode`
   (`META_PREPAID`/`META_POSTPAID`), never "segment".
2. **Maker-checker needs two platform admins.** The only documented platform
   login is `rush@xrush.online`. With A11 on and one admin, nothing can ever
   be approved.
3. **Switching weighted-average to FIFO changes figures already on screen.**
   "Gross BDT difference" and "Remaining stock value" will move. Show both
   side by side for one period before retiring the weighted-average cards.
4. **Meta spend is display-only today.** The `meta_amount_spent` snapshots are
   explicitly "display only, never a limit" (CLAUDE.md). Using them as
   accounting spend is a rule change. They're also cumulative, so spend events
   would be the deltas between snapshots, and a reset or edit on Meta's side
   would show up as negative spend.
5. **Limit approvals carry no platform BDT.** Agency Summary already counts
   approved pool-account limits as "USD allocated", but no BDT price is
   attached (`agency-allocations.ts`). Under A6 that's revenue with no amount.
6. **Platform audit can't use `audit_logs`.** That's already the rule in
   `finance.fns.ts`; v2's audit table must be platform-level.

## 4. Decisions needed before Milestone 1

**Plan defaults 4–11:** confirm or change (table in the plan).
`accounting-policy.ts` holds A4, A5 and A8. The tests pass under all three as
written.

**New questions from the mapping:**

- **Q1. Who is "the client" in the platform's book?** I read it as the agency
  (the platform sells USD/credit to agencies), so "client receivables" means
  what agencies owe the platform. The other reading, end clients of pool
  accounts, would duplicate the agency's own ledger. Then: is an agency
  billed per `usd_sales` row only, or also per approved pool-account limit,
  and at what rate?
- **Q2. What is a `usd_sales` row?** (a) USD actually handed over to the
  agency, so inventory leaves at sale (FIFO cost then), or (b) credit loaded
  onto platform Meta accounts, so inventory leaves only at Meta funding or
  settlement. The posting map differs.
- **Q3. Postpaid Meta cost timing.** The plan books cost at spend against a USD
  payable, but the BDT cost isn't known until settlement draws FIFO. With no
  FX revaluation (A10), that settlement entry can't balance in BDT.
  Recommended: cost = the settlement's FIFO cost; unsettled spend is a USD
  memo payable. Alternative: estimate at spend, book the difference at
  settlement to the FX difference account (which then gets used). The golden
  dataset assumes the recommendation.
- **Q4.** Which pool accounts are prepaid and which postpaid? Today they all
  behave as postpaid: Meta bills and "Balance owed to Meta" is `meta_balance`.
- **Q5.** OK to turn `meta_amount_spent` deltas into accounting spend (trap 4),
  or should spend be entered/imported?
- **Q6.** Who is the second approver for maker-checker (trap 2)?

**Open items from the plan, answered from the code:**

- *Invoices?* None. Agency→client receivables = `ledger_entries` (due derived
  by `client_financials()`). Platform→agency receivables don't exist yet.
- *How does Meta spend arrive?* API sync: `refreshMetaSnapshots()` reads each
  account's own node into `meta_amount_spent` (cumulative), plus the cron.
  There's no manual entry or CSV import. See Q5.

**Still the owner's to answer:** the real Payoneer example (agreed / landed /
BDT paid); suppliers paid before USD arrives (needs a supplier-advance
account); any other fees (client-side charges, wallet withdrawal, Meta tax,
own service fee).

## 5. Golden dataset

`src/lib/finance/golden-dataset.ts`, checked by `golden-dataset.test.ts`.
Every figure was computed by hand first.

| Step | Working | Result |
| --- | --- | --- |
| B1 Binance 1,000 @ 126, DBBL→DBBL | net 999.99; 999.99×126 = 125,998.74; + 0.01×126 = 1.26; + 0 | cost **126,000.00** |
| B2 Payoneer 500, fee 10 (yours 4) @ 128.50, NPSB | net 490; 490×128.5 = 62,965.00; + 4×128.5 = 514.00; + 10 | cost **63,489.00** |
| B3 Binance 300 @ 130, DBBL→DBBL | net 299.99; 38,998.70 + 1.30 | cost **39,000.00** |
| Fund prepaid P, $700 | 700 × 126,000 ÷ 999.99 | **88,200.88** (B1 left 299.99 / 37,799.12) |
| Settle postpaid Q, $450 | B1 299.99 → 37,799.12 (exact remainder) + B2 150.01 × 63,489 ÷ 490 = 19,436.70 | **57,235.82** |
| P spends $650 | 650 × 88,200.88 ÷ 700 | **81,900.82** (P left $50 / 6,300.06) |
| Closing inventory | B2 339.99 / 44,052.30 + B3 299.99 / 39,000.00 | **$639.98 / 83,052.30** = 228,489.00 − 145,436.70 |
| Revenue | X 700×135 = 94,500; Y 450×132 = 59,400 | **153,900.00** |
| Gross profit | 153,900 − (81,900.82 + 57,235.82) | **14,763.36** |
| Allocated, unspent | P's $50: billed 6,750.00, cost still in asset 6,300.06 | own report line |
| X pays 50,000 | receivable 94,500 → 44,500; revenue unchanged | |
| B4 posted by mistake, reversed | untouched → reversible; B1 (consumed) → refused | |

## 6. Proposed milestones and where each lands in the dashboard

The plan's roadmap graphic didn't come through, so this order is proposed.

| # | Builds | Dashboard change |
| --- | --- | --- |
| 1 | fee_rules, supplier institution, batch columns, `inventory_allocations`, `financial_transactions`, platform audit; `post_usd_purchase` / `post_usd_outgoing` RPCs (row-locked, idempotent); backfill opening batches | Purchase dialog gets gross/net/fees with rule preview and Payoneer share; **Source Summary → Suppliers** (institution, rule coverage); new **Batches** tab; USD Stock shows FIFO beside weighted-average |
| 2 | chart of accounts, journal entries/lines (balanced, immutable), posting map | **Journal** tab; trial balance |
| 3 | `meta_billing_mode`, funded lots, spend events, settlement, exceptions | **Meta Accounts** tab: funded / spent / remaining / payable, overspend exceptions |
| 4 | agency receivables and payments, selling rates, maker-checker, periods, reversals | **Receivables** tab; approval queue; period close; Agency Summary gains owed/paid |
| 5 | reconciliation (wallets, inventory), profitability, client-safe statement, CSV with formula escaping | **Profitability** (incl. allocated-unspent line) and **Reconciliation** tabs; go-live checklist |

Each migration goes to staging first (`docs/STAGING.md`), then production
before the merge that needs it, with before/after count and total snapshots.
