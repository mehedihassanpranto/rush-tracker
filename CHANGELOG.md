# Changelog

Daily log of what changed in Rush Tracker. One dated section per day of
work; newest at the top. Written by whoever (or whichever agent) makes the
changes — see the "Changelog convention" note in `CLAUDE.md`.

---

## 2026-08-23

**Removed the "Limit update proof" requirement from limit request
approval** — this proof was never provided by the client (their submission
form has no proof field at all); `uploadLimitProofFn` was `requireAdmin`-
gated the whole time, meaning it was the *admin's* own evidence, almost
certainly a screenshot of manually updating the spend cap on Meta before
approving. The "Auto-push approved limit increases to Meta spend_cap"
feature made that manual step obsolete. Removed both the server-side check
in `approveLimitRequestFn` (spec §29's mandatory-proof rule) and the
upload/replace UI on the admin approval screen; the "Proof attached ✓
View" display stays, but only rendered when a historical request already
has one — nothing can attach a new one anymore, so the block no longer
shows a permanent "no proof attached" for every future request.
**Correction made mid-implementation**: the first pass (removing only the
upload button, keeping the server-side requirement) would have completely
blocked approval on every future limit request, since nothing left in the
app could ever satisfy that check again — caught and fixed before
shipping.

## 2026-08-22

**Security fix: closed a payment-submission race that could bypass the
overpayment guard** — `submitPaymentFn` checked "amount ≤ due − pending
payments" with two plain `SELECT`s in application code, then inserted
afterward with no lock tying the read to the write. Two concurrent
`submitPaymentFn` calls from the same client (a script, or an unlucky
double-click) could both read the same pre-insert snapshot and each
independently pass the guard, letting a client stack multiple full-amount
`PENDING` payments beyond their real outstanding due — each looking like an
individually-valid payment with proof attached, risking over-crediting the
ledger if an admin approved more than one. New `submit_payment` RPC
(migration `20260723000016_atomic_submit_payment.sql`, `SECURITY DEFINER`,
row-locks the client via `for update` before computing due/pending and
inserting) closes the race the same way `approve_payment`/
`approve_limit_request` already do for their own atomic writes.
`submitPaymentFn` now just calls the RPC instead of doing the check+insert
itself; behavior and error messages are unchanged for the normal case.

**Added Telegram notifications for three events**: a client submits a limit
request, an ad account gets disabled on Meta, and an ad account crosses the
existing low-remaining-balance threshold — the latter two detected by the
daily `/api/cron/meta-sync` job (which previously only handled renames and
counting new unlinked accounts). New `sendTelegramMessage()`
(`src/server/telegram/telegram.service.ts`), best-effort like the existing
in-app `notify()`, no-ops when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
aren't configured. Called only from these three specific event sites, not
wired into every admin notification. Disabled/threshold alerts fire once
per transition, not every day the account stays in that state — new
`ad_accounts.meta_last_status_code` / `meta_low_balance_alerted` columns
(migration `20260723000018_meta_alert_state.sql`) track last-seen state so
the cron can tell "still disabled" apart from "just became disabled".
Threshold reuses the existing `LOW_BALANCE_THRESHOLD` (≤60, USD-only) so
there's one definition of "low" across the app, not two. The existing
in-app "Meta Business Portfolio sync" digest notification now also mentions
disabled/low-balance counts when they occur, so it stays accurate.

**Renamed the "External ID" field to "Ad account ID"** across the ad
account create/edit dialogs and the detail page's Account details card —
display label only, the underlying `external_account_id` column/field name
is unchanged. **Made it required on account creation** (both the create
dialog's Zod schema and, more importantly, the server-side
`adAccountCreateSchema` — the actual enforcement point): every new ad
account must now be linked to a real Meta account id from the start.
Editing an *existing* account still allows a blank value
(`adAccountUpdateSchema` untouched), so accounts created before today
aren't retroactively blocked from being edited until someone backfills
this field.

**Cleared xRush Digital's (CL-0001) financial history** at the owner's
explicit request — deleted its `ledger_entries` (5), `limit_requests` (2),
`adjustments` (3), and `payments` (1, + its proof file), leaving
`client_financials()` at zero. Deliberately preserved: both of the
client's logins, and its active ad account assignment (`ADA-0005`). This
bypassed `deleteClientFn`'s own history guard by design (a manual,
service-role script run outside the app, not a new feature) — logged as a
`CLIENT_FINANCIAL_DATA_PURGED` audit entry noting the manual purge and
what was deliberately kept, since audit history itself is never deleted
anywhere in this app.

## 2026-08-21

**Fixed: renaming an account in Meta didn't update it here on "Fetch"** —
name auto-sync only ever existed in the once-daily background cron; no
manual action applied it, and the Meta live-data card doesn't even show
Meta's name to notice a mismatch by eye. Extracted the cron's rename logic
into a shared function and wired it into both the ad account detail page's
"Fetch" button and the ad accounts list page's "Refresh" button — either
one now applies Meta's live name immediately when it differs, same safe
non-financial auto-apply the cron already does (no confirmation needed).
Audited with a distinct `metadata.source` so manual vs. cron renames are
still tellable apart in the audit trail. Verified live against a real
linked account: temporarily set its stored name to a stale placeholder
(local DB only, nothing touched on Meta's side), ran the sync, confirmed
it correctly restored the real name and wrote the right audit row.

**Added Current balance / Per USD / Remaining / Meta Due columns** to the
client detail page's Ad Accounts tab, matching what the admin ad accounts
list page already shows. Three of the four needed no new query — the
client's due and each account's own USD rate were already in the existing
data, just not rendered as columns. Remaining/Meta Due reuse the same bulk
Meta fetch and red-highlight-when-critical logic already used on the admin
list page. Verified live against a real client's data. Also added the
same low-remaining/high-Meta-Due red bell icons next to the account name
that the admin list page has, for full parity between the two views.

## 2026-08-20

**Closed the spec §9 profile-editing gap** — `/portal/profile` was a
hardcoded "later phase" stub with no write capability. Clients can now
edit their display name via an "Edit" button on the Account card. New,
dedicated `updateMyProfileFn` (not a relaxed call into the admin-side
login-edit fn, since that one force-confirms email changes with no
verification — unsafe to expose to self-service); this one only touches
`full_name`, scoped entirely to the caller's own session. Email editing is
explicitly out of scope for now. Verified end-to-end with a real headless
browser session against a real client login and the live Supabase
project (Playwright installed on demand for this, then removed again;
`package.json` untouched) — edited the name, saw the success toast and the
header update immediately, reloaded the page to confirm it actually
persisted server-side, and separately confirmed via the database that no
other login (including another one on the very same client) was touched.

**Added DB-backed integration settings** — a new "Meta integration" card
on `/admin/settings` where the three Meta credentials
(`META_SYSTEM_USER_TOKEN`, `META_BUSINESS_ID`, `META_API_VERSION`) can be
set/updated live, no redeploy needed. This exists because environment
variables genuinely can't be live-updated from application code on any
serverless platform — they're baked in per deployment. New `app_settings`
table (zero RLS access for authenticated users, service-role only — this
can hold a live secret) with env vars kept as the automatic fallback when
nothing's set in the DB, so nothing breaks for anyone who hasn't touched
this yet. New sensitive `integrations.manage` permission (SUPER_ADMIN by
default). The token is masked (last 4 chars) everywhere it's shown and
never round-trips to the browser after saving; a blank field on save means
"leave unchanged," never "clear it." **Migration not yet applied to the
live project** — confirmed live that the current pre-migration state falls
back to env vars cleanly with zero disruption to existing Meta features in
the meantime (the DB lookup's error is swallowed by design, logged, not
thrown). Updated one existing test (`permissions.test.ts`'s hardcoded
sensitive-permission count) — full suite (45 tests), typecheck, and build
all pass.

**Confirmed the integration-settings migration is live**, and fixed a real
bug the owner caught from a screenshot of the working page: the Business
Portfolio ID field showed autofilled with the owner's own email —
`autocomplete="off"` doesn't reliably stop this in Chrome. Saving it
unnoticed would have overwritten a working Business ID with garbage.
Added format validation (digits-only for the business ID, version-shaped
for the API version) as a hard backstop that rejects this regardless of
what the browser autofills, verified directly against the exact
autofilled value from the screenshot. Also caught and fixed a latent,
unrelated bug this surfaced: the original schema's `.min(1).optional()`
per field would have rejected a normal blank "leave unchanged" submit
outright, since `.optional()` only skips validation for `undefined`, not
an empty string.

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

**Fixed the `reset_all_data()` orphaned-employees gap** (documented as a
known issue on 2026-08-17): "Clear all data" now also truncates `employees`
(migration `20260723000014`) and resets its code counter, instead of
leaving employee rows behind with dead client links. Dialog copy updated to
mention employees. **Migration not yet applied to the live project** —
needs to be run before the next reset.

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
