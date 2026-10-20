# Accounting Policy — Platform Finance v2

Source: "Rush Tracker Financial Dashboard: Full Plan v2" (2026-10-20). This
file is the rulebook the code follows; `src/lib/finance/accounting-policy.ts`
holds the same defaults as constants. Change both together.

Scope: the **platform's** books (Platform → Finance & Accounts,
`/platform/finance`): USD bought from suppliers, held as inventory, and used
for Meta accounts and agencies. It does **not** change an agency's client
ledger (`ledger_entries`, `client_financials()`), which `PROJECT_SPEC.md`
governs, or an agency's own `/agency/finance` margin page.

Status legend: **[owner]** stated by the owner · **[confirmed]** the plan's
default, accepted by the owner on 2026-10-20 · **[open]** still waiting on a
real-world example.

Owner decisions of 2026-10-20 (Milestone 0 suggestions, all accepted):
two books — platform → agency, and agency → client; dollars leave the
platform's stock when **Meta's bill is paid**, not when a sale to an agency is
recorded (a sale / approved pool limit is revenue); postpaid cost is the
FIFO cost at settlement; every pool account is Meta-postpaid unless marked
otherwise; Meta spend = day-over-day change in the synced `amount_spent`,
with a manual correction and negative changes flagged; maker-checker is a
switch, OFF while there is one platform admin.

## 1. Fees

1. **[owner]** Dutch-Bangla → Dutch-Bangla: BDT 0. Any NPSB transfer to another
   bank: BDT 10 flat. You bear it as sender.
2. **[owner]** Binance: USD 0.01 per transfer, once, whatever the amount. You
   bear it.
3. **[owner]** Payoneer: entered by hand per purchase (total, your share,
   reason, optional statement). Default: supplier bears 100%.
4. Every fee is one record: total, your share, counterparty share, and either
   the matched rule id or "manual" + reason. The record is snapshotted at
   posting; later rule edits never change posted history.
5. A route with no matching rule **blocks posting**. It never defaults to zero.
   A free route is a matched rule with amount 0.
6. Same-bank transfers at a bank other than Dutch-Bangla have no rule until one
   is added, so they block too. That's deliberate.
7. A rule fee can be overridden only with a reason; the rule's own figure is
   kept beside the override.
8. Each supplier stores its receiving institution; the bank route (internal or
   NPSB) is derived from your bank and theirs.
9. A supplier rate outside BDT 124–131 per USD is a soft warning, never a
   block.

## 2. Batch cost

1. **[confirmed, A4]** The supplier prices on **net USD received**: you pay
   for the dollars that land plus your share of the USD fee.
2. **[confirmed, A5]** A fee you bear is in the batch's cost exactly once,
   and nowhere else (no second expense line).
3. Net USD = gross USD − the total of every USD fee deducted in transit
   (whoever bears it). **[open]** confirm with a real Payoneer example that the
   Payoneer fee is deducted from the amount sent.
4. Total BDT cost = BDT paid to the supplier + your share of the bank fee:
   exactly the taka that left your accounts, so the purchase's journal entry
   balances.
5. A USD fee is **never** added on top as fee × rate. No taka left for it; its
   cost is already inside the effective rate, because you paid for dollars
   that never landed. (The first version did add it, corrected the same day
   by migration 000060 before any real purchase was posted.)
6. Supplier rate = BDT paid ÷ (net USD + your share of the USD fees), the
   per-dollar price of the deal. Effective rate = total cost ÷ net USD, what
   FIFO consumes at.

## 3. Inventory and FIFO

1. All purchased USD is one shared inventory; each purchase is a batch.
2. Outgoing USD consumes the oldest batch first, by **posting order, then id**.
   One outgoing may split across batches; each allocation stores USD, batch,
   unit cost and BDT cost, and is insert-only.
3. Remaining inventory is always derived from posted batches and allocations,
   never a hand-edited total. Negative inventory is refused.
4. Rounding: a partial take costs round(take × BDT left ÷ USD left, 2); the
   take that empties a batch costs exactly its BDT left. So every batch's
   allocations sum to its cost to the paisa.
5. **[confirmed, A8]** A purchase dated before an already-consumed batch is
   refused.
6. Reversing a purchase is refused while any of its USD has been consumed.
   Reverse the downstream allocations first.

## 4. Meta accounts

"Prepaid/postpaid" here is **Meta's billing mode** for an ad account. It is not
the client payment segment (`clients.segment`: prepaid/partial/postpaid). The
column is named `meta_billing_mode` so the two never get confused.

1. **[confirmed, A7]** Prepaid: funding moves USD from inventory to a Meta prepaid
   asset and creates that account's own funded lots, at FIFO cost. Actual
   spend consumes the account's lots FIFO and becomes cost. Cost is recognized
   at spend, never at funding as well.
2. Spend above the funded balance is an **exception for review**. The asset
   never goes negative silently.
3. Postpaid (the default for every pool account): spend creates a USD payable
   to Meta; settlement — paying Meta's bill — consumes inventory FIFO and
   clears it. **[confirmed]** The BDT cost is the settlement's FIFO cost;
   spend not yet settled is a USD-only payable.
4. Funded, spent, remaining and outstanding payable are four separate figures
   everywhere. A spend cap is never shown as a balance.
5. Unspent credit leaves an account only through refund to client, return to
   inventory at the lot's original cost, or an approved write-off with a reason.

## 5. Revenue and receivables

1. **[confirmed, A6]** Revenue is recognized when credit is allocated, at the
   selling rate on that date (snapshotted). No deferred revenue in v1.
2. A payment reduces receivables only. Any overpayment is an advance, not
   revenue.
3. Refunds, credit notes and bad-debt write-offs are explicit, reasoned,
   approved transactions.
4. Revenue at allocation but cost at spend means margin runs ahead of spend.
   The profitability report shows allocated-but-unspent credit as its own line.

## 6. Money

1. PostgreSQL `NUMERIC` for all money. Rates 6 dp; USD 6 dp internally, 2 on
   display; BDT 2 dp. Server math in decimal.js.
2. USD and BDT are never added into one total.
3. Posted entries are immutable. Corrections are a linked reversal plus a
   replacement.
4. Reports use the event date (receipt, payment, allocation, spend,
   settlement), never `created_at`.
5. **[confirmed, A10]** No FX revaluation of USD payables in v1. One FX
   difference account exists, unused.
6. **[confirmed, A9]** Binance and Payoneer balances are the same USD as
   inventory, reconciled against each wallet's statement.

## 7. Controls

1. **[confirmed, A11 as a switch]** Maker-checker: the person who creates a
   posting, reversal or period reopening cannot approve it. OFF until a second
   platform admin exists (with one admin nothing could ever be approved);
   everything is audited meanwhile.
2. Periods are closed by an authorized role. A posting into a closed period is
   refused; corrections post into the next open period with a reference to
   the original. Reopening is logged with who and why.
3. Internal reports (FIFO cost, supplier, margin) are platform-admin only.
   Client-safe statements show allocated, spent, billed, paid and balance
   only. Agencies never see supplier rates, FIFO cost or margin on pool
   accounts.
4. Platform finance never writes to `audit_logs`: org zero is also xRush
   Agency, whose admins read that log. It gets its own platform-only audit
   table.
5. CSV exports filter columns by role and escape cells starting `= + - @`.

## 8. Journal (Milestone 2, migration 000061)

1. Double entry in **BDT**. USD is a memo on the lines that move dollars
   (inventory, revenue, Meta), never added to taka.
2. Every entry balances (Σ debit = Σ credit, ≥ 2 lines), checked by the
   database at commit; an unbalanced posting rolls back whole. Entries and
   lines are insert-only.
3. Posting is done by database triggers on the source tables, so nothing can
   record money without its entry. One entry per event, one mirror per
   reversal.
4. Posting map in force:

   | Event | Debit | Credit |
   | --- | --- | --- |
   | USD purchase | 1200 USD inventory | 1010 Bank & cash (principal; bank fee as its own line) |
   | Purchase from before v2 | 1200 | 3000 Opening balance equity |
   | Meta bill paid | 5000 Service cost — Meta | 1200 (FIFO cost) |
   | Opening adjustment (USD used before v2) | 3000 | 1200 |
   | Other USD outflow | 5900 Other USD outflows | 1200 |
   | Prepaid Meta funding | 1400 Meta prepaid | 1200 (FIFO cost) |
   | Prepaid Meta spend | 5000 Service cost — Meta | 1400 (the account's lot FIFO cost) |
   | Postpaid Meta spend | — no entry: no taka moves; a USD payable is tracked | |
   | Sale to an agency | 1300 Agency receivables | 4000 Revenue |
   | …its BDT received (v1: recorded paid at sale) | 1010 | 1300 |
   | Any reversal | the original's lines, sides swapped | |

5. The trial balance is by **event date** (as of the end of a Dhaka business
   day). The USD inventory account must equal the FIFO stock over everything
   posted; the Journal tab shows that tie-out.

## 9. Meta accounts in practice (Milestone 3, migration 000063)

1. Every platform pool account has a **Meta billing mode**:
   `META_POSTPAID` (the default) or `META_PREPAID`. Agency-owned accounts
   are not tracked in the platform's book.
2. **Spend is read from Meta once a day** (the meta-sync cron, 09:00 Dhaka)
   and on "Read spend now": the change in Meta's `amount_spent` since the last
   reading. Spend from before tracking began is history, not booked. USD
   accounts only (a non-USD account is flagged).
3. **A drop in Meta's figure** is flagged for review, never booked as negative
   spend; tracking restarts from the new figure. Missed spend is entered by
   hand with a reason.
4. **Postpaid:** spend is owed to Meta in USD (spend − bills paid). It costs
   nothing in the books until the bill is paid ("Meta bill paid", FIFO cost).
5. **Prepaid:** funding loads dollars from inventory into the account's own
   lots at FIFO cost. Spend uses those lots oldest-first. Spend beyond the
   lots is recorded, flagged, and costs nothing until it is dealt with: the
   prepaid asset never goes negative.
6. Prepaid → postpaid is refused while prepaid credit is left; a funding
   whose credit was spent can't be reversed before that spend is.
7. **Not yet built (Milestone 5):** returning unspent prepaid credit to
   inventory, or writing it off.

