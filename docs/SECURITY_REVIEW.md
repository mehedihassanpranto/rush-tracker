# Rush Tracker — Security Review (Phase 8)

Reviewed against spec §5, §58–§60, §62 and the Phase 8 hardening checklist
(§84). Scope: every table's Row Level Security, every server function's
authorization guard, cross-client isolation, secret handling, and file access.

**Outcome: PASS.** No authorization gaps found. Notes and defense-in-depth
observations are recorded below. This document should be re-run whenever a new
table or server function is added.

---

## 1. Secret / key handling (§59)

| Check | Status |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` is server-only, never `VITE_`-prefixed | PASS — read only in `env.server.ts`; `admin.server.ts` is wrapped in `createServerOnlyFn`. |
| Service-role client never reachable from client bundle | PASS — enforced by build-time import protection (`*.server.ts` cannot be imported by client-reachable code). |
| Browser Supabase client used for auth/session only | PASS — `lib/supabase/client.ts` is used only in login/logout/session flows; all business reads/writes go through server fns. |
| Secrets never written to audit logs / notifications | PASS — audit writes domain field diffs only; §55 "no secrets" respected. |

## 2. Row Level Security review (§60)

Every application table has RLS **enabled** and exposes **SELECT-only** policies
for the `authenticated` role. There are **no INSERT/UPDATE/DELETE policies
anywhere** — all writes go through the server layer with the service-role key
after application-level authorization. Confirmed by grepping all migrations for
`for insert|for update|for delete` (0 matches outside RPC `... for update` row
locks).

| Table | RLS | SELECT policy | Correct? |
| --- | --- | --- | --- |
| roles / permissions / role_permissions | on | any authenticated (reference data) | PASS |
| user_profiles | on | own row OR `is_admin()` | PASS |
| user_permissions | on | own rows OR `is_admin()` | PASS |
| clients | on | `is_admin()` OR `is_client_member(id)` | PASS |
| client_memberships | on | own rows OR `is_admin()` | PASS |
| audit_logs | on | `has_permission('audit_logs.view')` | PASS |
| ad_accounts | on | admin OR member of the active assignment's client | PASS |
| ad_account_assignments | on | admin OR member of that client | PASS |
| exchange_rates | on | `is_admin()` only | PASS — rates are internal. |
| limit_requests | on | admin OR `is_client_member(client_id)` | PASS |
| ledger_entries | on | (admin AND `ledger.view`) OR `is_client_member(client_id)` | PASS |
| attachments (proof metadata) | on | `is_admin()` only | PASS — clients never query it; proofs are served via signed URLs minted server-side. |
| adjustments | on | admin (see note) | PASS |
| payments | on | admin OR `is_client_member(client_id)` | PASS |
| payment_requests | on | admin OR `is_client_member(client_id)` | PASS |
| notifications | on | `user_id = auth.uid()` (own rows only) | PASS |

The `is_admin()`, `is_client_member()`, `has_permission()` and
`current_role_key()` helpers are `SECURITY DEFINER` with a pinned
`search_path = public`, so policy evaluation is not recursive and cannot be
shadowed by a client-set search path.

**Defense-in-depth note:** RLS is the *second* boundary. Because all business
reads also flow through server functions using the service-role key (which
bypasses RLS), the SELECT policies primarily protect any hypothetical direct
`anon`/`authenticated` browser query. They are intentionally strict so that even
that path stays client-scoped.

## 3. Authorization review — server functions (§62)

Every business server function calls a guard from
`server/auth/guards.server.ts` **before** doing work. Route guards
(`routes/admin/route.tsx`, `routes/portal/route.tsx`) are UX-only and are not
relied upon for security.

| Module | Guard(s) | Notes |
| --- | --- | --- |
| auth.fns | session-scoped | login/logout/getCurrentUser re-validate the JWT via `supabase.auth.getUser()`. |
| clients.fns | `requireAdmin(CLIENTS_VIEW / CLIENTS_MANAGE)` | user provisioning sets `app_role=CLIENT` in app_metadata (server-only). |
| ad-accounts.fns | `requireAdmin(AD_ACCOUNTS_VIEW / MANAGE)` | — |
| assignment.fns (assign/release/transfer) | `requireAdmin(AD_ACCOUNTS_ASSIGN / TRANSFER)` | multi-write via SECURITY DEFINER RPCs. |
| assignment.fns (listMy*, portal) | `requireClientMembership()` | scoped to `membership.clientId`. |
| limit-requests.fns (admin) | `requireAdmin(LIMIT_REQUESTS_VIEW / APPROVE)` | approval is a row-locked RPC. |
| limit-requests.fns (client) | `requireClientMembership()` | create verifies the account is assigned to the caller's client. |
| exchange-rates.fns | `requireAdmin(LIMIT_REQUESTS_VIEW / EXCHANGE_RATE_MANAGE)` | rate change is sensitive (SUPER_ADMIN by default). |
| ledger.fns (admin) | `requireAdmin(CLIENTS_VIEW / LEDGER_VIEW)` | — |
| ledger.fns (getMyStatement) | `requireClientMembership()` | scoped to `membership.clientId`. |
| adjustments.fns | `requireAdmin(ADJUSTMENTS_VIEW / CREATE)` | create/reverse are sensitive; corrections add rows only. |
| payments.fns (client) | `requireClientMembership()` | overpayment guard + proof-or-rollback. |
| payments.fns (admin) | `requireAdmin(PAYMENTS_VIEW / APPROVE)` | approval is a row-locked RPC. |
| payment-requests.fns (admin) | `requireAdmin(PAYMENT_REQUESTS_CREATE / PAYMENTS_VIEW)` | — |
| payment-requests.fns (client) | `requireClientMembership()` | — |
| dashboard.fns | `requireAdmin(DASHBOARD_VIEW)` / `requireClientMembership()` | — |
| notifications.fns | `requireUser()` | every query/update scoped by `user_id = user.id`. |
| audit.fns | `requireAdmin(AUDIT_LOGS_VIEW)` | — |
| reports.fns | `requireAdmin(REPORTS_VIEW)` | read-only. |
| search.fns | `requireAdmin(DASHBOARD_VIEW)` | server-side search; admin-only. |
| users.fns (read) | `requireAdmin(USERS_VIEW)` | staff list + role/permission state. |
| users.fns (write) | `requireAdmin(USERS_MANAGE)` | `users.manage` is sensitive → SUPER_ADMIN-only by default. Anti-escalation: a user **cannot change their own role, status or permissions**; per-user permission grants apply only to ADMIN targets. Role/status/permission changes are audited (ROLE_CHANGED / USER_STATUS_CHANGED / PERMISSION_CHANGED, spec §56). |

## 4. Cross-client isolation (§85 "cross-client authorization denial")

- No client-facing server function trusts a client-supplied `client_id`. Each
  derives the client from the session: `requireClientMembership()` returns the
  caller's active membership and every query filters on `membership.clientId`
  (verified in payments, limit-requests, ledger, dashboard, assignment,
  payment-requests).
- `submitPaymentFn` additionally re-checks that any linked `payment_request_id`
  belongs to the caller's client; `createLimitRequestFn` re-checks the account
  is actively assigned to the caller's client. So a client cannot pay against
  or request on another client's records even by forging an id.
- Proof download fns (`getMyPaymentProofUrlFn`, `getMyProofUrlFn`) re-verify the
  parent record belongs to the caller's client before minting a signed URL.
- `requireClientMembership()` also enforces the client is ACTIVE
  (`activeMemberships()` filters on membership + client status), so a suspended
  client's users lose access. Unit-tested in `lib/auth/types.test.ts`.

**Known limitation (not a vulnerability):** a user with memberships in multiple
clients is served their *first* active membership by the no-argument
`requireClientMembership()`; the portal does not yet offer a client switcher.
They can never see another, *unrelated* client's data — only that their own
secondary memberships aren't surfaced. Tracked for a future multi-client UX.

## 5. Financial integrity (§38, §39)

- Due is never stored; it is always derived from `ledger_entries`
  (`client_financials()` in SQL; `withRunningBalance()` for statements,
  unit-tested). No mutable `balance_after` column exists.
- Approved records are immutable; corrections only ADD ledger rows via
  `create_adjustment` / `reverse_financial_transaction` (both SECURITY DEFINER,
  service-role-only, duplicate-reversal guarded).
- All money-moving operations (limit approval, payment approval, assign/release/
  transfer, adjustment, reversal) are single SECURITY DEFINER RPCs that row-lock
  (`select … for update`) and write their audit row inside the transaction.
- Frontend-computed amounts are never trusted; the BDT charge is recomputed from
  approved USD × snapshotted rate server-side (decimal.js, unit-tested).

## 6. Follow-ups / recommendations

1. **Rotate the service-role key** if it was ever pasted into a chat, screen
   share, or committed by accident (see `.env` handling notes).
   *(Delegation note: granting an ADMIN the sensitive `users.manage` permission
   lets them manage other staff and grant permissions — grant it deliberately.
   The self-modification guard prevents self-escalation and self-lockout.)*
2. Keep the "no write policies" invariant: any new table must ship with RLS
   enabled + a SELECT-only policy and route all writes through a guarded server
   function. Re-run this review when adding tables/functions.
3. Consider a Postgres `check` or periodic reconciliation job asserting
   `sum(debit) - sum(credit) = client_financials.current_due` per client (the
   query is in `docs/TESTING.md`).
