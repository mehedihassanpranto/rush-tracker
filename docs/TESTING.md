# Rush Tracker — Testing & Reconciliation (Phase 8)

Covers spec §85 (testing requirements) and the Phase 8 checklist items
"financial reconciliation tests", "concurrency tests", and "file access tests".

Two layers:

1. **Automated unit tests** (`npm test`, Vitest) — the DB-independent business
   logic: decimal-safe money math, RBAC, cross-client gating, CSV export, and
   the ledger running-balance / due derivation.
2. **Live-DB procedures** — the rules that only exist inside PostgreSQL RPCs and
   Supabase Storage. Run these against a real Supabase project (staging first).
   Each is a copy-paste SQL check or a short manual script.

---

## 1. Automated unit tests

```bash
npm test          # one-shot
npm run test:watch
```

Current suite (45 tests, all passing):

| File | Covers (§85) |
| --- | --- |
| `lib/money/money.test.ts` | BDT billing calculation; bills requested amount only (no billing from opening balance); decimal safety; editable-rate multiplication. |
| `lib/ledger/running-balance.test.ts` | Client-level due calculation; statement running balance; decimal exactness. |
| `lib/auth/types.test.ts` | RBAC (SUPER_ADMIN bypass, ADMIN explicit grants, sensitive-permission denial); cross-client isolation via `activeMemberships`. |
| `lib/permissions/permissions.test.ts` | Permission catalog integrity; sensitive-permission set. |
| `lib/csv/csv.test.ts` | Report CSV escaping/quoting. |
| `lib/meta/spend-cap-sync-decision.test.ts` | Meta spend_cap auto-sync branching (not §85): unlinked/non-USD skip, would-pause-delivery guard, already-synced idempotency, write. Not §85 — a post-Phase-8 addition. |
| `server/meta/spend-cap-sync.test.ts` | Same feature's Meta-calling core, with `fetchMetaAdAccount`/`updateMetaAdAccountSpendCap` mocked: success write, retry-then-fail on fetch/write errors, no write when already in sync. Not §85. |

## 2. §85 coverage map

| §85 requirement | Where verified |
| --- | --- |
| Opening balance behavior | Unit (money) + Procedure A |
| Limit request creation | Procedure A |
| Approved amount differs from requested | Procedure A (approve with edited amount) |
| Editable USD rate | Unit (money) + Procedure A |
| BDT billing calculation | **Unit** (money.test.ts) |
| Stale opening balance rejection | Procedure B |
| Duplicate limit approval prevention | Procedure C |
| Account transfer / transfer opening balance | Procedure D |
| No billing from opening balance | **Unit** (money.test.ts) + Procedure A |
| Payment submission / pending behavior | Procedure E |
| Payment approval | Procedure E |
| Partial payment | Procedure E |
| Duplicate payment approval prevention | Procedure F |
| Adjustment / Reversal | Procedure G |
| Client-level due calculation | **Unit** (running-balance) + Procedure H |
| Cross-client authorization denial | **Unit** (auth) + Procedure I |

---

## 3. Financial reconciliation (run any time)

**H — Due equals ledger, for every client.** Due is never stored; this asserts
the derivation matches a from-scratch sum. Expect **0 rows**.

```sql
select c.id, c.client_code,
       coalesce(sum(l.debit_bdt),0) - coalesce(sum(l.credit_bdt),0) as raw_due,
       f.current_due
from public.clients c
left join public.ledger_entries l on l.client_id = c.id
cross join lateral public.client_financials(c.id) f
group by c.id, c.client_code, f.current_due
having (coalesce(sum(l.debit_bdt),0) - coalesce(sum(l.credit_bdt),0))
     <> f.current_due;
```

**Every approved limit request has exactly one LIMIT_APPROVAL ledger row.**
Expect **0 rows**.

```sql
select lr.id, lr.request_number, count(le.id) as ledger_rows
from public.limit_requests lr
left join public.ledger_entries le
  on le.reference_type = 'LIMIT_REQUEST' and le.reference_id = lr.id
where lr.status = 'APPROVED'
group by lr.id, lr.request_number
having count(le.id) <> 1;
```

**Every approved payment has exactly one PAYMENT credit row.** Expect **0 rows**.

```sql
select p.id, p.payment_number, count(le.id) as ledger_rows
from public.payments p
left join public.ledger_entries le
  on le.reference_type = 'PAYMENT' and le.reference_id = p.id
where p.status = 'APPROVED'
group by p.id, p.payment_number
having count(le.id) <> 1;
```

**No pending/rejected/cancelled payment ever touched the ledger.** Expect **0**.

```sql
select p.id, p.payment_number, p.status
from public.payments p
join public.ledger_entries le
  on le.reference_type = 'PAYMENT' and le.reference_id = p.id
where p.status <> 'APPROVED';
```

**BDT charge = approved USD × snapshotted rate (half-up, 2dp).** Expect **0**.

```sql
select lr.id, lr.request_number, lr.bdt_charge,
       round(lr.approved_amount_usd * lr.approved_usd_rate, 2) as expected
from public.limit_requests lr
where lr.status = 'APPROVED'
  and lr.bdt_charge <> round(lr.approved_amount_usd * lr.approved_usd_rate, 2);
```

---

## 4. Live-DB functional procedures

Seed helpers are in `supabase/seed.sql` (promote a user to SUPER_ADMIN; create a
dev client + membership).

**A — Limit lifecycle, edited amount & rate, opening-balance billing.**
1. Assign an AVAILABLE account (opening limit e.g. $2,000) to a client.
2. As the client, request +$500.
3. As admin, upload proof, approve but **change** the amount to $400 and the
   rate away from default; approve.
4. Check: account `current_limit_usd` = $2,400; one LIMIT_APPROVAL ledger row
   with `debit_bdt = 400 × your rate` (NOT 2,400 × rate — opening balance is
   never billed); the request stores the immutable `approved_usd_rate`.

**B — Stale opening-balance rejection.** Create a pending request; then approve
a *different* limit change on the same account so its live limit moves. Attempt
to approve the first request → RPC raises `STALE_BASELINE: …`. Use "Rebase" and
re-approve → succeeds.

**C — Duplicate limit approval prevention.** Approve a request, then call
`approve_limit_request` again on the same id (or double-click Approve) → the
second call fails (status no longer PENDING). Exactly one ledger row exists.

**D — Account transfer & transfer opening balance.** Transfer an ACTIVE account
from client X to client Y. Check: X's assignment is RELEASED with a
`closing_limit_usd`; Y has a new ACTIVE assignment whose `opening_limit_usd`
equals the account's current limit (carried over, not re-billed); both clients'
members receive a notification; no ledger/due change from the transfer itself.

**E — Payment submission, pending, approval, partial.** As client with due
₹10,000: submit ₹6,000 with proof → status PENDING, **due unchanged**. As admin,
approve → one PAYMENT credit, due = ₹4,000, linked request → PARTIALLY_PAID.
Submit the remaining ₹4,000 and approve → due = 0, request → PAID.

**F — Duplicate payment approval prevention.** Approve a payment, then call
`approve_payment` again on the same id → fails; exactly one credit row.

**G — Adjustment & reversal.** Create an ADD_DUE adjustment (₹1,000) → due rises
by 1,000, one adjustment row + one ledger debit. Reverse a chosen ledger entry →
an opposite ledger row + adjustment row appear; reversing the same entry twice is
blocked (duplicate-reversal guard).

**H — see reconciliation §3** (run after A–G; all checks return 0 rows).

**J — Meta spend_cap auto-sync after approval (post-Phase-8 addition).**
Covers the automatic push from an approved limit request to the linked Meta
ad account's `spend_cap` (`syncAndPersistAdAccountSpendCap`,
`src/server/meta/spend-cap-sync.server.ts`), triggered from
`approveLimitRequestFn`. Needs a real, safe test Meta ad account (USD
currency, $0 or near-$0 spend — do not use a live-spending account) linked
via `external_account_id` to a real `ad_accounts` row assigned to a test
client.

*Success path:*
1. Note the account's live `spend_cap` on Meta (Ads Manager or a `GET
   act_{id}?fields=spend_cap`) and its `current_limit_usd` here — they
   should already match from a prior run, or don't if this is the first run.
2. As the client, request a small increase (e.g. +$10). As admin, upload
   proof and approve.
3. Confirm `ad_accounts.current_limit_usd` updated to the new value (already
   covered by procedure A) **and** re-fetch the account live from Meta —
   `spend_cap` should now equal the same new value. Confirm
   `meta_sync_pending = false` and `meta_sync_error is null` on the row.
4. Check `audit_logs` for one new `AD_ACCOUNT_UPDATED` row with
   `metadata->>'source' = 'META_SPEND_CAP_AUTO_SYNC'` and
   `actor_user_id` = the approving admin's id.

*Failure path:* force the Meta call to fail — easiest is temporarily
renaming `META_SYSTEM_USER_TOKEN` in the environment (or, if testing against
a deployed environment, temporarily pointing the test account's
`external_account_id` at a bogus id) — then repeat steps 2–3 with a fresh
limit request.
1. Confirm the approval still succeeds (ledger debit + `APPROVED` status +
   `current_limit_usd` updated) — a Meta failure must never block or roll
   back the approval itself.
2. Confirm `ad_accounts.meta_sync_pending = true` and `meta_sync_error` is
   set to a readable message.
3. Confirm a `notifications` row was created for every ACTIVE admin with
   `type = 'META_SPEND_CAP_SYNC_FAILED'`.
4. Restore the token/external id, then click "Retry sync" on the account
   detail page (or wait for the next `/api/cron/meta-sync` run, which also
   calls `retryPendingMetaSpendCapSyncs()`) — confirm `meta_sync_pending`
   clears and Meta's live `spend_cap` now matches `current_limit_usd`.

*Idempotency:* with the account already in sync (`meta_sync_pending =
false`, live `spend_cap` = `current_limit_usd`), manually invoke the sync
again (retry button, or re-run the cron) — confirm no new Meta write happens
(no change to Meta's `spend_cap`) and no duplicate audit row is written; the
account should report `synced` without a `graphPost` call
(`decideSpendCapSync`'s `already_synced` branch).

---

## 5. Concurrency tests

The money-moving RPCs row-lock (`select … for update`) the account / payment /
ledger before mutating, so concurrent callers serialize.

- **Double-approve race:** fire two `approve_limit_request` (or
  `approve_payment`) calls on the same id near-simultaneously (two SQL editor
  tabs, or a small script). Exactly one succeeds; the other sees a non-PENDING
  status and fails. Verify one ledger row.
- **Concurrent limit approvals on one account:** two pending requests can't both
  exist (unique one-pending-per-account index); approving one then the other
  triggers the stale-baseline path rather than a lost update.
- **Assign race:** two `assign_ad_account` calls for the same AVAILABLE account
  → one wins, the other fails because the row is locked and no longer AVAILABLE.

Simple driver (psql): open two sessions, `begin;` + call the RPC in each before
committing, and observe the second block then fail.

## 6. File access tests (proofs)

- The `proofs` bucket is **private**. Confirm in Supabase Storage settings that
  it is not public.
- Copy a stored object path and request
  `https://<project>.supabase.co/storage/v1/object/proofs/<path>` **without** a
  token → expect `400/403` (no anonymous access).
- Downloads must use a **signed URL** minted server-side (`signProofUrl`, 60s).
  Fetch a fresh signed URL → 200; wait >60s and refetch the same URL → expect
  `403` (expired).
- As client A, call `getMyPaymentProofUrlFn` with client B's payment id → the
  server rejects it ("Payment not found") before any URL is minted.
- Uploads only occur server-side as base64 through the server fn (≤3 MB, jpg/
  png/webp/pdf); there is no browser→storage write path.

## 7. Serverless / deployment verification

See `docs/DEPLOYMENT.md` for the Vercel deploy and the production smoke-test
checklist (env vars, cold-start of a server fn, auth round-trip, proof signing).
