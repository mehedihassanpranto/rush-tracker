# Changelog

Daily log of what changed in Rush Tracker. One dated section per day of
work; newest at the top. Written by whoever (or whichever agent) makes the
changes — see the "Changelog convention" note in `CLAUDE.md`.

---

## 2026-08-19

**Confirmed migration `20260723000011_ad_accounts_external_id_unique.sql`
is live** — a second SQL-editor run of the file surfaced `42P07: relation
"idx_ad_accounts_external_unique" already exists`, which only happens once
the first run already succeeded. So the unique-partial-index backstop
against duplicate Meta account links has been applied since (at latest)
this check; `CLAUDE.md`'s "not yet applied" note from the Phase 8 hardening
pass was stale and is now updated. Flagged that the migration file itself
isn't safely re-runnable (its `drop index if exists` only targets the
pre-migration index name) — don't re-run it through the SQL editor again.

**Resolved the open `spend_cap` write-units question** from the Meta
integration hardening pass — ran a live read-write-read-restore test
against a safe $0-spend account (`act_963630549557499`, "DF IT - Darun
Food 03") using the System User token: original raw `spend_cap: "70000"`
(= $700.00), wrote `157`, read back `"15700"` (= $157.00, confirming the
write field is dollars, not cents — a cents write would have read back
`"157"` = $1.57), then restored to `700` and verified the raw value
returned to `"70000"`. `amount_spent` was `"0"` throughout, so no live
delivery was ever at risk. `updateMetaSpendCapFn`'s existing dollars-write
assumption is now confirmed correct; no code change was needed.

**Auto-push approved limit increases to Meta's spend_cap** — closes the
manual step where an admin approves a client's limit increase and someone
still has to go update the linked Meta ad account's spend cap by hand.
After `approve_limit_request` commits, `approveLimitRequestFn`
(`src/server/limit-requests/limit-request.fns.ts`) now calls the new
`syncAndPersistAdAccountSpendCap()` (`src/server/meta/spend-cap-sync.server.ts`)
as a best-effort step, same "never blocks the primary operation" pattern as
the existing notification calls. It reuses the existing
`updateMetaAdAccountSpendCap()`/`fetchMetaAdAccount()` Meta client rather
than adding a parallel Graph API path, and the same USD-only, no-FX-path
rule the manual "Edit spend cap" dialog already enforces (non-USD or
unlinked accounts are skipped as not-applicable, never treated as
failures). The actual branching logic (skip/already-synced/would-pause-
delivery/write) is a pure function, `decideSpendCapSync()`
(`src/lib/meta/spend-cap-sync-decision.ts`), unit tested directly with no
mocks; the Meta-calling core `syncAdAccountSpendCap()` is unit tested
separately with `fetchMetaAdAccount`/`updateMetaAdAccountSpendCap` mocked —
14 new tests, 45 total.

**Approvals are never rolled back on a Meta failure.** The ledger debit,
`current_limit_usd` update, and audit row already commit atomically inside
`approve_limit_request` before any Meta HTTP call is even possible, and the
spec treats approved financial records as immutable — so a Meta-side
failure instead flags the account (`ad_accounts.meta_sync_pending` +
`meta_sync_error` + `meta_sync_attempted_at`, migration
`20260723000013_ad_account_meta_sync_state.sql`), fires a new
`META_SPEND_CAP_SYNC_FAILED` admin notification, and logs. Retried two ways:
the existing daily `/api/cron/meta-sync` job now also calls the new
`retryPendingMetaSpendCapSyncs()` (no new cron entry — avoids any
assumption about the Vercel plan's cron-frequency limits), and admins get an
immediate manual "Retry sync" button + a red out-of-sync banner on the ad
account detail page (`retryMetaSpendCapSyncFn`, `AD_ACCOUNTS_MANAGE`-gated).
Idempotent by construction: the decision function compares Meta's live
spend_cap to the target before writing, so retries/duplicate triggers
converge without re-POSTing.

Audited as `AD_ACCOUNT_UPDATED` with a new, distinct
`metadata.source: 'META_SPEND_CAP_AUTO_SYNC'` — kept separate from the
existing manual-dialog source `META_SPEND_CAP_PUSH'` so the audit trail can
tell an admin's manual push apart from the system's automatic one.

Added a new documented live-DB test procedure (`docs/TESTING.md` §4,
Procedure J) for the full approve → sync flow (success, forced failure,
retry, and idempotency) — matches this codebase's existing Phase 8 split
(Vitest for DB-independent pure logic only, live-project procedures for
DB-enforced flows) rather than introducing a new Supabase-mocking test
pattern.

**Ran Procedure J live** against the real linked account `ADA-0012` and a
throwaway account with a bogus Meta id — real Meta write + audit on
success, correct no-op on a repeat run, correct failure flagging +
notification on a real Graph API error, and the retry cron correctly
picking up the pending row; the real account was fully restored afterward.
This caught one real bug, fixed in the same pass: `already_synced` was
collapsing into the same `synced` status as an actual write, so a retry or
duplicate trigger against an already-in-sync account wrote a redundant
audit row every time. Also visually verified the out-of-sync banner +
"Retry sync" button in a real headless-browser session (screenshots,
logged in via a magic link for a real admin account rather than a shared
password) — renders correctly, click round-trips through the real server
function with the correct toast.

## 2026-08-18

**Added a "Usage" tab** to the ad account detail page (`Overview |
Assignment History | Usage`) — a running total of USD requested/approved
against the account, starting from its opening balance and accumulating
every subsequent approved limit request. No new table or migration needed:
the additive opening-balance model (spec §28) was already recorded on every
`limit_requests` row, just never surfaced as a history view before. Shows a
"Total USD used" summary plus a per-request table (client, approval date,
opening balance, requested, approved, new limit), scoped to the account's
whole lifetime across every client that has held it. Verified against a
real account (`ADA-0012`): one approved request, $700 opening + $100 →
$800, matching the account's live current limit exactly.

**Added a "Spent Amount" column** to the Assignment History table
(after Closing) — `closing_limit_usd − opening_limit_usd` per assignment
period, decimal.js. Implemented as closing-minus-opening rather than the
literally-requested opening-minus-closing, since limits only ever grow
during an assignment; the reverse would show negative numbers on nearly
every row. Shows `—` for the currently-active (not yet released)
assignment, same as the existing Closing column.

**Added a "Limit Requests" tab** to the client detail page, between
Adjustments and Logins — every approved limit request the client has ever
had, across all their ad accounts, most-recent-first. Shows which account,
the approved USD amount, and the approval date in a custom format
(`08:00pm, 7 april 2026`), driven by `approved_at` per the owner's
instruction. Verified live against both real clients with approval
history (7 and 3 requests respectively) — accounts, amounts, and dates all
correct.

## 2026-08-17

**Added a "Fetch" button** to the ad account detail page header — refetches
the account's own data, assignment history, and live Meta data together in
one click, matching the list page's "Refresh" button.

**Added Delete for employees** (blocks if still assigned to any client,
same precaution as client deletion) — while verifying it live, ran into a
confirmed intentional use of the "Clear all data" Danger Zone feature,
which pre-dates the employees feature and doesn't clear
`employees`/`client_employees`, leaving employees orphaned after a reset.
Owner's call: leave that as-is for now. Re-verified the delete feature
itself with a fully self-contained test afterward (creates and cleans up
its own temp data) — works correctly.

**Fixed a real lockout**: a client login (`mehedi.h.pranto@gmail.com`,
CL-0002 DF IT) hit "No active client access" because its
`client_memberships.status` was INACTIVE — with no admin UI to fix it,
requiring a direct database update. Added `setClientMembershipStatusFn` and
`updateClientUserProfileFn` (scoped to the exact user+client pair, never by
user alone) plus a dropdown per row on the client detail page's Logins tab
(Edit profile / Activate / Deactivate) so this is self-service for admins
going forward. Verified live: deactivate/reactivate round-trips correctly,
and a mismatched (user, wrong client) pair correctly touches nothing.

**Employees + Team Members** — a request that arrived as a diagram proposing
to restructure the whole app around `Rush Tracker → Clients → Employees`.
Turned out, after clarification, to mean two additive features, with the
existing ad-account/limit/ledger/payment/Meta domain left completely
untouched:

- **Employees** (agency staff assigned to service clients, admin-only): new
  `employees` + `client_employees` tables (migration `…0012`, `EMP-000N`
  codes), new permissions, `/admin/employees` ("All Employees" reverse
  lookup) and a new "Employees" tab on the client detail page.
- **Team Members** (a client's own staff, self-added with real portal login
  access): no new table — reuses the existing `client_memberships`
  mechanism, just self-service from `/portal/team` instead of admin-only.
  Client-scoped server-side so one client can never touch another's team.
- Seeded the 6 placeholder employees (E1–E6) and wired them to the 3 real
  clients per the owner's diagram; the diagram's 4th client had no real
  counterpart, so that one assignment was explicitly skipped rather than
  faked. Verified live, including the many-to-many case (one employee
  serving two clients).

**Meta Business Portfolio integration** (read, sync, and spend-cap writes) —
the big addition of the day:

- Read-only Graph API integration via a Business Portfolio System User
  token — fetch one account, list/import from the whole Business Portfolio
  (`owned_ad_accounts` + `client_ad_accounts`, not just the former, which
  silently misses most of an agency's managed accounts).
- Background sync (`GET /api/cron/meta-sync`, Vercel Cron, daily) —
  auto-renames drifted account names, notifies admins about new
  unlinked accounts without auto-importing them.
- Pull direction: apply Meta's live spend cap as this app's own
  `current_limit_usd`. Push direction: edit Meta's spend cap from an
  increment-based confirm dialog ("increase by $X"), the only WRITE this
  integration makes to Meta.
- Three distinct "balance" figures added to the admin ad-accounts
  list/detail pages, deliberately never sharing a label: **Remaining**
  (Meta spend headroom), **Current balance** (the assigned client's actual
  ledger due), **Balance owed to Meta** (Meta's own accrued bill) —
  plus a **Meta Due** list column and a red-bell / double-red-bell alert
  for low remaining / high Meta Due.
- Manual **Refresh** button on the ad accounts list (force-refetches past
  the Meta query's cache window).
- Admin bootstrap: provisioned the first SUPER_ADMIN login
  (`mehedi.h.prantoz@gmail.com`) directly against the live Supabase
  project.

**Hardening pass** (a `/code-review --level max` audit, 4 parallel review
angles, over the whole Meta integration) — 7 of 8 findings fixed:

- `updateMetaSpendCapFn` no longer trusts a client-computed absolute
  spend cap; the server now computes the new cap from Meta's own live
  value at write time (closes a stale-baseline race between concurrent
  edits).
- Fixed a real crash bug in `listClientAccountsFn` (missing `current_due`
  on a type-unsafe cast).
- `getAdAccountFn` / `listClientAccountsFn` no longer pay for a full
  cross-client ledger aggregate to resolve one client's due.
- Meta buttons/data now properly hidden from view-only admins instead of
  erroring (permission-gating inconsistency).
- Low-balance bell / Meta Due alert no longer fire on flat USD-scale
  thresholds for non-USD accounts.
- Duplicate-import race narrowed (pre-insert check) and backstopped by a
  new DB migration (`20260723000011`, unique partial index on
  `external_account_id`) — **not yet applied to the live project**.
- **Left open, unresolved**: whether Meta's `spend_cap` write is really in
  dollars or cents was never empirically proven — a live test write was
  blocked by Claude Code's safety classifier. Research favors "dollars"
  3 sources to 1, not conclusive. Do not trust `updateMetaSpendCapFn` with
  a real financial decision until this is confirmed.

**Client portal**:

- Fixed a data over-exposure: the dashboard's "My Ad Accounts" section was
  shipping the full `ad_accounts` row (including the internal `usd_rate`
  and raw `external_account_id`) to the client bundle unrendered. Narrowed
  to only the fields actually displayed.
- Added red/emerald urgency styling to "Current Due" wherever it appears
  client-side (dashboard card, Due page) — previously plain black text
  regardless of how much a client owed.
- Added a **Remaining** column (Meta spend headroom) to `/portal/ad-accounts`
  — via a new, genuinely client-scoped server fn (not a relaxed admin one)
  that filters the Business Portfolio down to only the calling client's own
  accounts before anything leaves the server. Verified live: zero data
  overlap with another client's accounts.
- Added the same low-balance red bell to the client's own ad accounts list,
  with the currency-safety gate applied correctly from the start (the admin
  side needed that fixed after the fact; the client side didn't repeat the
  mistake).

**Repo housekeeping**: pushed to `main` in stages (Meta integration →
hardening pass → portal fixes); `docs/DEPLOYMENT.md` updated with the new
Meta/cron env vars and a note that Vercel's Hobby plan caps cron to daily.
