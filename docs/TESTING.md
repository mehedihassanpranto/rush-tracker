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

Current suite (31 tests, all passing):

| File | Covers (§85) |
| --- | --- |
| `lib/money/money.test.ts` | BDT billing calculation; bills requested amount only (no billing from opening balance); decimal safety; editable-rate multiplication. |
| `lib/ledger/running-balance.test.ts` | Client-level due calculation; statement running balance; decimal exactness. |
| `lib/auth/types.test.ts` | RBAC (SUPER_ADMIN bypass, ADMIN explicit grants, sensitive-permission denial); cross-client isolation via `activeMemberships`. |
| `lib/permissions/permissions.test.ts` | Permission catalog integrity; sensitive-permission set. |
| `lib/csv/csv.test.ts` | Report CSV escaping/quoting. |

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
