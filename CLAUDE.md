# Rush Tracker — Agent Instructions

**Read `docs/PROJECT_SPEC.md` before implementing or changing anything.** It is
the source of truth for business rules, financial logic, and security
boundaries. If code conflicts with the spec, the spec wins. Note: the tail of
the spec copy (after §85) was truncated in transfer — ask the owner for the
full document if you need the testing/later sections.

## Changelog convention

**`CHANGELOG.md` (repo root) gets a dated entry for every day changes are
made** — newest day at the top. When you finish a piece of work (or before
ending a session where you changed something), add or extend today's
section with a short summary of what changed, grouped by feature/area, not
a raw file list. This is separate from the `## Status` phase log below:
Status tracks the big, feature-level "what exists now" narrative; the
changelog tracks day-by-day "what happened," including hardening passes,
bug fixes, and anything else that isn't a whole new named feature.

## Status

- **Phase 0 (architecture verification): done** — conventions below were
  verified against installed packages.
- **Phase 1 (foundation): done** — auth, RBAC, layouts, route protection,
  Phase 1 schema. Verified against a live Supabase project by the owner.
- **Phase 2 (clients + ad accounts): done** — client CRUD + login
  provisioning, ad-account CRUD/rename/status, and atomic
  assign/release/transfer with assignment history. Migration
  `20260723000002_phase2_clients_accounts.sql`.
- **Phase 3 (limit management): done, pending owner review** — client limit
  requests (one-pending-per-account), admin approval queue + approval screen
  with editable amount/rate, mandatory proof upload, stale-baseline detection
  + rebase, atomic approval RPC that updates the account limit and writes the
  first ledger debit, exchange-rate management. Migration
  `20260723000003_phase3_limits.sql`.
- **Phase 4 (ledger and accounting): done, pending owner review** — ledger
  views (admin global + per-client with running balance, client statement),
  client financial summary (approved USD / billed / paid / due, all
  ledger-derived), adjustments (ADD_DUE/REDUCE_DUE) and reversals, dashboard
  due/billing cards. Migration `20260723000004_phase4_ledger.sql`.
- **Phase 5 (payments): done, pending owner review** — client pay-due (full or
  partial) with mandatory proof, overpayment guard, payment history + cancel;
  admin verification queue + approve (atomic ledger credit) / reject; admin
  payment requests (create from client detail or list, cancel) with status
  lifecycle. Migration `20260723000005_phase5_payments.sql`.
- **Phase 6 (dashboards): done, pending owner review** — all admin/client
  summary cards live (incl. Today's approved USD/billing/collection at the
  Asia/Dhaka business day), plus section feeds: admin pending queues, clients
  with highest due, recent approvals/payments, recent activity (audit log);
  client my-accounts, pending requests, payment requests, recent
  payments/transactions. Migration `20260723000006_phase6_dashboard.sql`
  (`admin_today_totals`, `top_due_clients`).
- **Phase 7 (notifications, reports, audit): done, pending owner review** —
  in-app notifications (bell + unread badge in the header, portal notifications
  page, best-effort fan-out to admins/client-members after each event), audit
  log UI (filter by action/entity/date), reports section (Client Due, Limit
  Approval, Payment Collection, Adjustment/Reversal, Ad Account Usage, USD Rate
  Usage — all with CSV export), and admin global search (header box +
  `/admin/search`). Migration `20260723000007_phase7_notifications_reports.sql`
  (`notifications` table + RLS, `all_client_dues()`).
- **Phase 8 (hardening): done, pending owner review** — security review
  (`docs/SECURITY_REVIEW.md`: RLS matrix + per-fn authorization matrix +
  cross-client isolation, all PASS), Vitest unit suite (31 tests over money
  math, RBAC, cross-client gating, CSV, ledger running-balance — `npm test`),
  live-DB reconciliation/concurrency/file-access test plan mapped to §85
  (`docs/TESTING.md`), and the Vercel deploy + production verification checklist
  (`docs/DEPLOYMENT.md`). No new migration.
- **User management (post-Phase-8 addition): done, pending owner review** —
  admin **Users** screen (`/admin/users`): list staff, provision admin/super-
  admin logins, change role (ADMIN↔SUPER_ADMIN), activate/deactivate, and
  grant/revoke per-user permissions (ADMIN targets; role defaults locked on,
  sensitive ones flagged). `src/server/users/user.fns.ts`; reads need
  `users.view`, writes need `users.manage` (sensitive → SUPER_ADMIN by default).
  Anti-escalation: a user cannot change their own role/status/permissions. No
  new migration (reuses `user_profiles`, `user_permissions`, `roles`). Audited
  as ROLE_CHANGED / USER_STATUS_CHANGED / PERMISSION_CHANGED / USER_CREATED.
- **Meta Business Portfolio integration (post-Phase-8 addition): done, pending
  owner review** — read-only Graph API integration via a Business Portfolio
  System User token (`META_SYSTEM_USER_TOKEN` + `META_BUSINESS_ID`, optional
  server-only env, app runs without them). `src/server/meta/meta.server.ts`
  (Graph client, `fetchMetaAdAccount`, `listMetaBusinessAdAccounts`).
  **`listMetaBusinessAdAccounts` queries both `{business}/owned_ad_accounts`
  AND `{business}/client_ad_accounts`, merged + deduped by account id** — an
  agency's managed accounts mostly live in `client_ad_accounts` (shared in
  from clients' own Business Managers), not `owned_ad_accounts`; querying
  only the latter (the original mistake here) silently misses most accounts,
  including newly-assigned ones, with no error to signal it.
  `src/server/meta/meta.fns.ts` exposes `fetchMetaAdAccountFn` (verify/prefill
  one account by id — wired into the create dialog's External ID field and a
  "Fetch from Meta" action on the account detail page, both display-only, no
  auto-overwrite), `listMetaBusinessAdAccountsFn` (lists the Portfolio's
  accounts, flags ones already linked by `external_account_id`), and
  `importMetaAdAccountsFn` (bulk-creates `ad_accounts` rows — wired into an
  "Import from Meta" dialog on the ad accounts list). Both writes/reads are
  guarded by `requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)`; imports are
  audited as `AD_ACCOUNT_CREATED` with `metadata.source = 'META_IMPORT'`. No
  new migration (`external_account_id` already existed, unindexed-unique).
  **Deliberate scope decision**: Meta's numeric `account_status` is shown as
  an informational label only, never written to our `ad_accounts.status`
  (that stays admin-controlled, spec §19). Bulk import never maps
  `spend_cap`/`currency` onto `current_limit_usd` either — imported accounts
  always start at `current_limit_usd: 0`, `status: AVAILABLE`, unassigned;
  batch-applying a financial baseline across accounts with possibly-different
  currencies with no per-account review was judged too risky. Single-account
  spend-cap application (see below) is the reviewed exception.
- **Meta background sync (post-Phase-8 addition): done, pending owner
  review** — `GET /api/cron/meta-sync`, invoked every 6h by Vercel Cron
  (`vercel.json` → `crons`), auth'd by a shared secret (`CRON_SECRET`; Vercel
  auto-sends `Authorization: Bearer <CRON_SECRET>`, 401 without it). Business
  logic in `src/server/meta/meta-sync.server.ts::syncMetaAdAccounts()` — no
  `requireAdmin()` (no signed-in actor on a cron call; the secret header is
  the auth boundary instead). Scope stays narrow on purpose: auto-renames an
  already-linked account when Meta's live name differs (safe, non-financial,
  audited as `AD_ACCOUNT_RENAMED` / `metadata.source: 'META_SYNC'`,
  `actorUserId: null`); **never** auto-creates `ad_accounts` rows for newly
  seen Meta accounts (financial baseline + rate need an admin decision) — new
  accounts are only counted and surfaced via `notifyAdmins()` (`type:
  'META_SYNC'`), admin still imports them by hand via the existing "Import
  from Meta" dialog. `AuditEntry.actorUserId` widened to `string | null` for
  this (audit_logs.actor_user_id is a nullable FK to auth.users — no
  placeholder ids).
  **Framework note learned the hard way**: standalone Nitro `server/api/**`
  file scanning does **not** get wired into this TanStack Start version's
  (1.168.x) request pipeline — `createStartHandler` owns routing end-to-end.
  Custom HTTP/API endpoints must be a normal file under `src/routes/**`
  using `createFileRoute(path)({ server: { handlers: { GET: async ({
  request }) => ... } } })` (no `component` key ⇒ never shipped to the
  client bundle), picked up by the same `routeTree.gen.ts` generation as
  page routes. Don't reach for a top-level `server/` dir again.
  **Meta API correctness note**: `owned_ad_accounts` alone misses most of an
  agency's accounts — `listMetaBusinessAdAccounts()` now queries both
  `{business}/owned_ad_accounts` and `{business}/client_ad_accounts` (see
  above). Separately, Meta's `amount_spent`/`spend_cap` on the AdAccount
  object are wire-formatted in the account currency's **minor unit** (cents
  for USD; zero-decimal currencies like JPY/KRW are the exception, listed in
  `ZERO_DECIMAL_CURRENCIES`) — `meta.server.ts`'s `toSummary()` normalizes
  both to major units before they reach any caller, so `MetaAdAccountSummary`
  is always real currency amounts, never raw Graph API cents. Verified
  against a live account: raw `spend_cap: "870000"` → correctly $8,700.00,
  not $870,000 — getting this wrong is a 100x error.
- **Apply Meta spend cap as current limit (post-Phase-8 addition): done,
  pending owner review** — `applyMetaSpendCapFn` in `meta.fns.ts`: re-fetches
  live from Meta server-side (never trusts a client-supplied number),
  requires `currency === 'USD'` (no FX conversion path exists here — other
  currencies must be applied manually), then sets
  `ad_accounts.current_limit_usd` to the live spend cap — same non-billing,
  no-ledger-entry semantics as directly editing the field via the existing
  Edit dialog (spec §20's baseline, not a billing event). Wired as an
  explicit "Apply as current limit" confirm step (shows old → new value) in
  `MetaFetchDialog` (detail page) and as an automatic USD-only prefill of
  `current_limit_usd` when fetching on the create dialog. Audited as
  `AD_ACCOUNT_UPDATED` with `metadata.source = 'META_SPEND_CAP'`. Still never
  wired into bulk import — see the scope decision above.
- **Meta live spend on the account detail page (post-Phase-8 addition):
  done, pending owner review** — new "Meta live data" card on the ad
  account detail page's Overview tab (`$accountId.tsx`), shown whenever the
  account has an `external_account_id`. Auto-fetches (no click needed) via
  the existing `fetchMetaAdAccountFn`; shows Amount spent, Remaining
  (`spend_cap − amount_spent`, decimal.js via `dec()`, "No spend cap set"
  when Meta has none), Spend cap, and Currency — formatted with
  `Intl.NumberFormat({style:'currency'})` against the account's own Meta
  currency, not assumed USD (unlike `formatUsd`/`formatBdt`, which are
  specific to this app's own two currencies). Purely a read from Meta on
  each page view — no new columns, nothing persisted, degrades to a quiet
  "unable to load" line on fetch failure rather than breaking the page.
- **Low-remaining-balance bell on the ad accounts list (post-Phase-8
  addition): done, pending owner review** — red Bell icon (lucide) next to
  an account's name in `/admin/ad-accounts` when its live Meta
  `spend_cap − amount_spent` is **≤ 60** (`LOW_BALANCE_THRESHOLD` at the top
  of `index.tsx`), in the account's own currency — no FX conversion, same
  currency-native gate as the rest of the Meta integration. Originally
  shipped as a closed [50,60] band per the literal request, then corrected
  to an open-ended `≤ 60` after the owner found a real $36.60 account
  (deeper in the red than the band) showing no bell — lower remaining is
  still low, a band that excludes the most urgent accounts was backwards.
  Reuses `listMetaBusinessAdAccountsFn` (the same bulk fetch behind "Import
  from Meta" — two Graph API calls for the whole portfolio, not one per row)
  rather than adding new server code; `staleTime: 2min` so navigating the
  list repeatedly doesn't hammer the
  Graph API. Verified against all 15 real linked accounts before shipping.
  Same query also powers a **"Remaining" column** on the list (Meta spend
  headroom, every linked account not just low-balance ones — red/bold when
  low, `—` when unlinked or Meta has no spend cap). Formatting factored out
  of `$accountId.tsx`'s Meta live-data card into a shared
  `formatCurrencyAmount()` in `src/lib/money/money.ts` (currency-native
  `Intl.NumberFormat`, not `formatUsd`/`formatBdt`) once it was needed in a
  second place. `LOW_BALANCE_THRESHOLD` lives in `src/lib/meta/thresholds.ts`
  (isomorphic, not `.server.ts`, since both the list page and the detail
  page's Meta live-data card need it client-side).
  **"Remaining" (Meta) vs "Current balance" (ours) — do not conflate these,
  a mistake made once already**: "Remaining" is Meta's `spend_cap −
  amount_spent`, an ad-account-level, Meta-side, non-financial figure (how
  much budget is left before Meta pauses delivery). "Current balance" is the
  assigned **client's due** — ledger-derived (spec §35), client-level, our
  own billing figure — sourced from `all_client_dues()` the same way
  `listClientsFn` does it, merged into `AdAccountClient.current_due` inside
  `currentClientMap()` (`ad-account.fns.ts`). Shown as its own column on the
  list (next to "Current client") and its own row on the detail page's
  **Account details** card (next to "Current client" there too) — deliberately
  kept out of the "Meta live data" card since it has nothing to do with
  Meta. Multiple ad accounts under the same client correctly show the same
  due figure (it's a client total, not per-account) — verified against real
  data (CL-0002 DF IT: ৳323,400 due, identical across all of DF IT's linked
  accounts).
  **A third, genuinely different "balance" exists too — Meta's own AdAccount
  `balance` field** (Ads Manager's Billing tab calls this "Current balance":
  amount accrued against the account since Meta's last payment, charged to
  the linked payment method once Meta's own threshold is hit). Added to
  `MetaAdAccountSummary.meta_balance` (`meta.server.ts`, same minor-unit
  normalization as amount_spent/spend_cap — verified live: raw `"2452"` →
  correctly $24.52, matching the owner's screenshot of that exact account).
  Shown only in the "Meta live data" card, labeled **"Balance owed to
  Meta"** — deliberately not reusing "Current balance" a second time on the
  same page (that label is already taken by the client-due figure above);
  three distinct "balance" concepts now exist on this one page and none of
  their labels should ever collide again: Remaining (Meta spend headroom),
  Current balance (client due, ours), Balance owed to Meta (Meta's bill).
- **Write to Meta: push spend_cap (post-Phase-8 addition): done, pending
  owner review** — the only WRITE this integration makes; everything else
  is `ads_read`. `updateMetaAdAccountSpendCap()` in `meta.server.ts`
  (`graphPost` helper, form-encoded POST to `act_{id}`) — verified against
  Meta's official API reference before shipping: **writing `spend_cap` is
  in major units (standard denomination, e.g. `"100.00"`), the opposite of
  reading it (minor units/cents)** — an asymmetric GET/POST convention for
  this one field, documented loudly in code so it's never "fixed" into a
  100x bug. `updateMetaSpendCapFn` (`meta.fns.ts`, `AD_ACCOUNTS_MANAGE`)
  re-fetches live Meta state server-side first and blocks (before writing
  anything) if the new cap would fall below `amount_spent` — that would
  make Meta pause all delivery on the account immediately, so it's refused
  rather than left as a surprise. On success also sets our own
  `current_limit_usd` to match (owner's call — the two are allowed to
  differ from Meta's spend_cap in general, but this write path keeps them
  in sync). Audited as `AD_ACCOUNT_UPDATED` / `metadata.source:
  'META_SPEND_CAP_PUSH'` (distinct from the pull-direction `'META_SPEND_CAP'`
  source used by `applyMetaSpendCapFn`).
  **UI is increment-based, not absolute** (`MetaSpendCapDialog`,
  spec-§74-style confirmation dialog) — admin types "increase spend cap by
  $X", the dialog computes and displays "New spend cap" (current + X)
  before submit, and that computed absolute value is what's actually sent
  — same additive mental model as the rest of the app's limit-request flow
  (spec §20: new limit = opening balance + approved amount), not a
  type-the-final-number field. Triggered from an "Edit spend cap" button
  (`CardAction`) on the detail page's "Meta live data" card.
  Also checked (per owner's screenshot of Meta's "Account spending limit →
  When the limit resets: Manually / Automatically on the 1st" toggle): the
  documented write API has no recurring-reset parameter at all — only the
  one-time `spend_cap_action: 'reset'|'delete'`. Our write can't set or
  flip that toggle either way; it only ever touches the cap value.
- **Manual "Refresh" button on the ad accounts list (post-Phase-8
  addition): done, pending owner review** — both list queries (our own
  `ad-accounts` and the bulk `meta-business-ad-accounts`, the latter has a
  2-minute `staleTime`) are force-refetched together via `refetch()`, which
  always hits the network regardless of `staleTime` — a manual click isn't
  blocked by the cache window that normal navigation respects. Spinning
  icon while either is in flight; a toast distinguishes "fully refreshed"
  from "refreshed, but live Meta data failed" (e.g. Meta not configured)
  rather than failing the whole action.
- **"Meta Due" column on the ad accounts list (post-Phase-8 addition):
  done, pending owner review** — the fourth "balance" figure, this one on
  the list page: `MetaAdAccountSummary.meta_balance` (the "Balance owed to
  Meta" value already shown on the detail page) surfaced per row. Reuses
  the same bulk `metaAccounts` fetch already powering "Remaining"/the bell —
  `balanceByAccountId`'s map entries no longer require `spend_cap` to be
  non-null to exist (an account can have a Meta bill balance with no spend
  cap set at all; the old gate would've silently hidden Meta Due for those
  rows). Verified against 5 real linked accounts (e.g. ADA-0007: $9.32).
- **Double red bell for high Meta Due (post-Phase-8 addition): done,
  pending owner review** — `META_DUE_THRESHOLD = 100` in
  `src/lib/meta/thresholds.ts` (alongside `LOW_BALANCE_THRESHOLD`, same
  file). When `meta_balance >= 100`, two overlapping `Bell` icons render
  next to the account name (`-space-x-1.5`) — visually distinct from the
  single bell used for low *remaining* spend headroom, since the two alerts
  mean opposite things (spend room running low vs. Meta bill running high)
  and can both be true independently for the same account. Meta Due cell
  itself also goes red/bold when crossed, same treatment as the Remaining
  column. Verified live: `ADA-0012 "DF IT - Random 4"` at $112.11 correctly
  triggers it; every other linked account (all under $100) correctly
  doesn't.
- **Meta integration hardening pass (post-Phase-8 addition): done, pending
  owner review** — a `/code-review --level max` audit of the whole Meta
  integration (4 parallel review angles) surfaced 8 findings; 7 fixed here,
  1 explicitly left open pending live verification:
  - **`updateMetaSpendCapFn` no longer trusts a client-computed absolute
    spend_cap.** Schema changed `spend_cap_usd` → `increase_by_usd`; the
    server now computes `newCap = live meta.spend_cap (fetched in this same
    call) + increase_by_usd`, never from whatever the dialog had cached
    when it opened. Fixes both the "never trust frontend-computed amounts"
    violation and a stale-baseline race (two admins editing concurrently
    could silently overwrite each other). `MetaSpendCapDialog` now sends
    the raw increment; its "New spend cap" preview is relabeled "Estimated"
    since the server recomputes from fresh data at submit time.
  - **Real crash bug fixed**: `listClientAccountsFn` (`assignment.fns.ts`,
    powers the client detail page's Ad Accounts tab) cast a client row to
    `AdAccountClient` via `as unknown as` without supplying the (session-
    added) required `current_due` field — `formatBdt(undefined)` would have
    thrown the moment anything read it. Now resolves the client's due via
    `client_financials(client_id)`.
  - **`getAdAccountFn`/`listClientAccountsFn` efficiency**: both were
    (transitively) paying for the bulk `all_client_dues()` cross-client
    aggregate to resolve a single client's due. `currentClientMap()` now
    branches: one distinct client → `client_financials(client_id)` (cheap,
    single-row); multiple distinct clients (the list page) → still the bulk
    RPC. Verified the single-client RPC returns byte-identical values to
    the bulk one for 3 real clients before relying on it.
  - **Permission-gating inconsistency fixed**: `fetchMetaAdAccountFn` /
    `listMetaBusinessAdAccountsFn` require `ad_accounts.manage`, but the
    list/detail pages only required `ad_accounts.view` and rendered the
    Meta buttons/queries unconditionally — a view-only admin got a
    FORBIDDEN that looked like a Meta outage. Both pages now compute
    `canManageMeta = hasPermission(user, PERMISSIONS.AD_ACCOUNTS_MANAGE)`
    (same pattern as `clients/index.tsx`'s `canManage`) and gate the Meta
    queries' `enabled` plus the Import/Refresh/Fetch/Edit-spend-cap
    buttons and the whole "Meta live data" card on it.
  - **Currency-blind thresholds fixed**: `LOW_BALANCE_THRESHOLD` /
    `META_DUE_THRESHOLD` were compared against `remaining`/`meta_balance`
    regardless of currency, unlike every other Meta-money code path in this
    integration (deliberately USD-gated, no FX conversion). The bell/Meta
    Due alert flags (not the raw displayed values, which still show
    correctly for any currency) now only evaluate when `currency === 'USD'`.
  - **Duplicate-import race narrowed + backstopped**: `importMetaAdAccountsFn`
    now re-checks for already-linked `external_account_id`s immediately
    before inserting (the import dialog's candidate list can be stale by
    submit time). Migration `20260723000011_ad_accounts_external_id_unique.sql`
    adds a **unique partial index** (`where external_account_id is not
    null`) as the hard backstop — confirmed zero existing duplicates in
    live data before adding it, so it applies cleanly. **Confirmed applied
    to the live project on 2026-08-19** — re-running the file's `create
    unique index` a second time surfaced `42P07: relation
    "idx_ad_accounts_external_unique" already exists`, which is only
    possible once the first run already succeeded. Note the migration
    itself isn't safely re-runnable (line 13's `drop index if exists`
    targets the pre-migration index name, not this one), so don't re-run
    this file through the SQL editor a second time.
  - Duplicated USD/linked-account guard logic between `applyMetaSpendCapFn`
    and `updateMetaSpendCapFn` extracted into a shared `loadUsdLinkedAccount()`.
  - **Resolved 2026-08-19**: whether `spend_cap` writes are in dollars (as
    documented/implemented) or cents was empirically confirmed live against
    a safe $0-spend account (`act_963630549557499`, "DF IT - Darun Food
    03"). Read original `spend_cap: "70000"` (= $700.00, minor-unit read
    convention), wrote `spend_cap=157`, read back `"15700"` (= $157.00 —
    matches the dollars theory exactly; a cents write would have read back
    `"157"` = $1.57), then restored `spend_cap=700` and verified the raw
    value returned to `"70000"`. `amount_spent` stayed `"0"` throughout, so
    no live delivery was ever at risk. `updateMetaSpendCapFn`'s existing
    dollars-write assumption is confirmed correct — no code change needed.
- **Client portal quick fixes (post-Phase-8 addition): done, pending owner
  review** — a portal-side survey (comparing `/portal` against spec §9/§66-68
  and the admin side's Meta hardening) turned up two safe fixes, applied:
  - **Data over-exposure fixed**: `clientDashboardSectionsFn`
    (`dashboard.fns.ts`) was selecting the full `ad_accounts` row
    (`account:ad_accounts(*)`) for the dashboard's "My Ad Accounts" section,
    shipping `usd_rate` (internal per-account billing rate) and
    `external_account_id` (raw Meta id) to the client bundle even though
    neither was rendered. Narrowed to `id, name, current_limit_usd, status`
    — new `ClientDashboardAccount = Pick<AdAccount, ...>` type, matching the
    already-correct pattern in `listMyRequestableAccountsFn`
    (`limit-request.fns.ts`). Verified live: query still returns correct
    shape for a real client (CL-0002, 6 accounts).
  - **Due-amount urgency styling added**: both places "Current Due" appears
    client-side (`portal/index.tsx`'s dashboard stat card,
    `portal/due/index.tsx`'s Due page card) now color it red/bold when > 0
    and emerald when 0 ("You're all settled up"), reusing the same red/
    emerald language the admin side already uses for low-balance/high-due
    alerts — previously plain black regardless of urgency, on the one page
    where it's the client's own money at stake.
  - **Also identified, not yet built**: the client ad-accounts table folds
    spec §67's "Pending Request" column into the action button's label
    instead of a separate column (a dedicated-column version was tried and
    then deliberately reverted per owner feedback — the button-label
    version reads better). The profile-editing stub noted here was closed
    later — see the dedicated entry further below.
- **"Remaining" surfaced to clients (post-Phase-8 addition): done, pending
  owner review** — the open decision above got resolved: owner chose to add
  Meta spend headroom ("Remaining") to `/portal/ad-accounts`, the client's
  own ad accounts list. New `listMyAccountsMetaRemainingFn`
  (`meta.fns.ts`, new "Client" section — the file was previously all-admin)
  is **not** a relaxed version of an admin fn; it's a new function gated by
  `requireClientMembership()`, not `requireAdmin`. It reuses the same bulk
  `listMetaBusinessAdAccounts()` call the admin side uses (still 2 Graph API
  calls total, not one per client) but the full portfolio response never
  leaves the server — it's filtered down to only the calling client's own
  actively-assigned `external_account_id`s before being returned. Verified
  live: correct remaining values for a real client's 6 accounts, **and
  confirmed zero overlap with another client's account set** (the
  authorization boundary that matters most here). Wired into
  `portal/ad-accounts/index.tsx` as a new "Remaining" column, best-effort
  (`retry: false`, shows `—` per row rather than breaking the page if Meta
  is unreachable). No currency gate on the displayed value itself
  (display-only — same reasoning as `formatCurrencyAmount` elsewhere).
  A follow-up added the same low-balance red `Bell` next to the account
  name as the admin side (`LOW_BALANCE_THRESHOLD`, shared from
  `src/lib/meta/thresholds.ts` — same "≤60, open-ended below" semantics,
  not the closed-band mistake made and fixed earlier), **with the same
  `currency === 'USD'` gate the admin side needed fixed** — applied
  correctly from the start here rather than repeating that bug. Verified
  live: CL-0002's "DF IT - Own" at $19.90 correctly triggers it, the other
  5 of that client's accounts (all well above $60) correctly don't.
  "Meta Due" and Meta's own spend_cap were deliberately still left out
  client-side (see the reasoning
  above) — only "Remaining" was judged to actually belong to the client.
- **Employees + Team Members (post-Phase-8 addition): done, pending owner
  review** — two deliberately separate features that both use the word
  "employee" colloquially but must never be confused (a naming-collision
  risk flagged and avoided up front, same discipline as the "Remaining" vs
  "Current balance" vs "Meta Due" separation above):
  - **Employees** (agency staff assigned to service clients — admin-only).
    New tables `employees` + `client_employees` (migration `…0012`,
    `EMP-000N` codes via the same sequence-default pattern as
    `CL-000N`/`ADA-000N`; plain many-to-many junction, no assignment
    history/status — not asked for). New permissions `employees.view` /
    `employees.manage`, granted to ADMIN by default, not sensitive.
    `src/server/employees/employee.fns.ts`. UI: `/admin/employees` (the
    "All Employees" reverse lookup — employee → every client they serve)
    and a new "Employees" tab on the existing client detail page
    (assign/unassign) — an *addition* to that page, nothing existing there
    was touched. RLS is admin-only (`is_admin()`) — the client portal has
    no visibility into this at all, by design.
  - **Team Members** (a client's own staff, self-added from the portal,
    granted real portal login access) — **not a new table.** Reuses
    `client_memberships`/`user_profiles`/`auth.users`, the exact mechanism
    the admin's existing "Add login" already writes to. New
    `src/server/team/team.fns.ts`, guarded by `requireClientMembership()`
    instead of `requireAdmin()` — the `client_id` is always taken from the
    caller's own membership, never accepted as input, so a client can only
    ever add/manage teammates under their own account. UI: `/portal/team`.
    Any active member of a client can add/deactivate a teammate — no
    owner/admin tier exists among client users (confirmed with the owner
    before building rather than inventing one).
  - **This was a request to restructure the whole app** (a diagram showing
    `Rush Tracker → Clients → Employees`) that turned out, after
    clarification, to mean "add two new, mostly-independent features
    alongside the existing system" — the ad-account/limit/ledger/payment/
    Meta domain (the app's actual reason to exist) was **never touched**.
    Seeded 6 placeholder employees (E1–E6, real `EMP-000N` codes) mapped
    onto the 3 real clients per the owner's diagram (xRush Agency/DF
    IT/KiKi ← C1/C2/C3); the diagram's C4 has no real-client counterpart,
    so E6's second assignment was skipped rather than inventing a fake
    4th client — flagged explicitly, not silently dropped. Verified live
    against the exact query the "All Employees" page runs: `EMP-0003 "E3"
    → xRush Agency, DF IT` confirms the many-to-many case (one employee,
    two clients) round-trips correctly.
- **Edit login profile + membership status (post-Phase-8 addition): done,
  pending owner review** — closes a real gap found live: a client's
  `client_memberships.status` could go INACTIVE (in this case, from testing
  the new self-service "Team Members" deactivate action) with **no admin
  UI to reverse it** — the Logins tab showed the status as a read-only
  badge only, forcing a direct database fix the first time it happened.
  `setClientMembershipStatusFn` and `updateClientUserProfileFn`
  (`client.fns.ts`, both `CLIENTS_MANAGE`) — both take **both**
  `user_id` and `client_id` and scope the update to that exact pair via a
  double `.eq()`, never by `user_id` alone, so a login belonging to
  multiple clients (theoretically possible, not yet a real case) can't
  have the wrong membership touched. Verified live against the account
  that triggered this: deactivate → reactivate round-tripped correctly,
  and a deliberately mismatched (user, wrong client) pair correctly
  matched zero rows instead of silently touching something. Wired into
  the Logins tab as a dropdown per row (Edit profile / Activate /
  Deactivate) — same pattern as the Employees tab's row actions.
  Password reset is explicitly out of scope here (a different, larger
  concern — not requested).
- **Delete employee (post-Phase-8 addition): done, pending owner review** —
  `deleteEmployeeFn` (`employee.fns.ts`, `EMPLOYEES_MANAGE`) mirrors
  `deleteClientFn`'s precaution exactly: blocks with a clear error if the
  employee has any current `client_employees` link, telling the admin to
  unassign first rather than silently cascading (unlike clients there's no
  *financial* history at stake here, but "unassign first" keeps the same
  predictable Delete behavior admins already expect elsewhere in the app).
  `DeleteEmployeeDialog` mirrors `DeleteClientDialog`. Verified with a
  fully self-contained test (creates its own temp client + employee +
  link, confirms blocked-while-assigned and allowed-after-unassigning,
  deletes everything it created) — deliberately not tested against real
  seed data after an earlier verification attempt against the real `E1`
  employee turned into a live incident (see below).
  **Incident, for the record**: that verification coincided with
  discovering `reset_all_data()` (the Settings → Danger Zone "Clear all
  data" feature) had been run — an intentional, confirmed action, not data
  corruption, and not something this delete feature caused. Confirmed
  live: `clients`/`client_memberships`/`ad_account_assignments`/ledger/
  payments/all CLIENT logins were wiped exactly as that function
  documents. One real gap surfaced by this: **`reset_all_data()` predates
  `employees`/`client_employees` (added this session) and doesn't clear
  them** — `TRUNCATE ... CASCADE` on `clients` cascades into
  `client_employees` (FK reference) but `employees` itself has no such FK,
  so employee rows survive a reset while every one of their client
  assignments doesn't, leaving them orphaned/"Unassigned". Left as-is at
  the time; later fixed — see the `reset_all_data() now clears employees`
  entry below.
- **"Fetch" button on the ad account detail page (post-Phase-8 addition):
  done, pending owner review** — a visible page-header button (matching
  the list page's "Refresh"), refetches everything shown on the page in
  one click: the account's own stored fields, assignment history, and
  (if linked + permitted) live Meta data together via `Promise.all`. A
  Meta-side failure is reported as a separate warning toast rather than
  failing the whole action — same graceful-degradation pattern as the list
  page. Distinct from the existing "Fetch from Meta" dropdown item, which
  opens `MetaFetchDialog` for a narrower purpose (preview Meta's live
  spend cap before optionally applying it as `current_limit_usd`) — kept
  both since they serve different jobs, not true duplicates despite the
  similar naming.
- **"Usage" tab on the ad account detail page (post-Phase-8 addition): done,
  pending owner review** — surfaces a per-account cumulative USD usage trail
  (`Overview | Assignment History | Usage`). Turned out to need **no new
  table or migration**: spec §28's additive model
  (`opening_balance_usd` → `+approved_amount_usd` → `approved_new_limit_usd`)
  was already captured on every `limit_requests` row, just never displayed
  as a running history — it was only ever used internally for stale-baseline
  validation (§30). New `listAdAccountUsageFn`
  (`limit-request.fns.ts`, `LIMIT_REQUESTS_VIEW`) returns every **APPROVED**
  request for one `ad_account_id`, most-recent-approval-first (changed
  2026-08-30 from ascending on owner request — plain `.order('approved_at',
  { ascending: false })`, no other code depended on the row order since
  `totalUsage` is an order-independent client-side sum and each row's
  opening/approved/new-limit figures are already complete per-row values,
  not computed from array position), across every client that
  has ever held the account (same all-time scope as Assignment History) —
  PENDING/REJECTED/CANCELLED requests are excluded since they never became
  real usage. Tab shows a "Total USD used" summary card (client-side sum via
  `dec()`, decimal.js — display aggregation only, not a write) plus a table
  of Client / Approved date / Opening balance / Requested / Approved amount /
  New limit per row. Wired into the existing page-header "Fetch" button's
  `Promise.all` alongside the account/history/Meta refetches. Added the
  long-missing `approved_at` field to the `LimitRequest` TS type (the DB
  column existed since the Phase 3 migration; only `reviewed_at` had ever
  been exposed to TypeScript). Verified live: `ADA-0012 "DF IT - Darun Food
  03"` — one approved request, opening $700 + $100 → $800, matching the
  account's live `current_limit_usd` exactly.
- **Auto-push approved limit increases to Meta spend_cap (post-Phase-8
  addition): done, pending owner review** — closes the manual step where an
  admin approves a client's limit increase and someone still has to update
  the linked Meta ad account's spend cap by hand. After `approve_limit_request`
  commits, `approveLimitRequestFn` (`limit-request.fns.ts`) now calls the new
  `syncAndPersistAdAccountSpendCap()` (`src/server/meta/spend-cap-sync.server.ts`)
  as a best-effort step (same pattern as the existing post-approval
  notification call — never blocks or rolls back the approval). Reuses the
  existing `updateMetaAdAccountSpendCap()`/`fetchMetaAdAccount()` Meta client
  and the same USD-only, no-FX-path rule the manual "Edit spend cap" dialog
  already enforces — non-USD or unlinked accounts are skipped as
  not-applicable, never treated as failures. The branching (skip /
  already-synced / would-pause-delivery / write) is a pure function,
  `decideSpendCapSync()` (`src/lib/meta/spend-cap-sync-decision.ts`), unit
  tested with no mocks; the Meta-calling core `syncAdAccountSpendCap()` is
  unit tested separately with the Meta client mocked (14 new tests, 45
  total — `npm test`).
  **Never rolls back an approval on a Meta failure** — the ledger debit,
  `current_limit_usd` update, and audit row already commit atomically inside
  `approve_limit_request` before any Meta HTTP call is even possible, and
  approved financial records are immutable by spec. A Meta failure instead
  flags the account (`ad_accounts.meta_sync_pending` / `meta_sync_error` /
  `meta_sync_attempted_at`, migration
  `20260723000013_ad_account_meta_sync_state.sql`), fires a new
  `META_SPEND_CAP_SYNC_FAILED` admin notification, and logs. Retried via the
  existing daily `/api/cron/meta-sync` job, which now also calls the new
  `retryPendingMetaSpendCapSyncs()` — deliberately **no new cron entry**, to
  avoid any assumption about the Vercel plan's cron-frequency limits — plus
  an immediate manual "Retry sync" button + red out-of-sync banner on the ad
  account detail page (`retryMetaSpendCapSyncFn`, `AD_ACCOUNTS_MANAGE`).
  Idempotent by construction: `decideSpendCapSync()` compares Meta's live
  spend_cap to the target before writing, so retries/duplicate triggers
  converge without re-POSTing. Audited as `AD_ACCOUNT_UPDATED` with a new,
  distinct `metadata.source: 'META_SPEND_CAP_AUTO_SYNC'` — kept separate
  from the existing manual-dialog source `'META_SPEND_CAP_PUSH'` so the
  audit trail can tell an admin's manual push apart from the system's
  automatic one. New live-DB test procedure: `docs/TESTING.md` §4,
  Procedure J (success, forced failure, retry, idempotency) — matches this
  codebase's existing Phase 8 split (Vitest for DB-independent pure logic
  only, live-project procedures for DB-enforced flows) rather than
  introducing a new Supabase-mocking test pattern.
  **Verified live end-to-end on 2026-08-18** against the real linked account
  `ADA-0012` ("DF IT - Darun Food 03") and a throwaway account with a bogus
  Meta id: real Meta write + audit row on success, correct idempotent no-op
  on a second run (this caught a real bug — `syncAndPersistAdAccountSpendCap`
  was writing a duplicate-looking audit row on every already-in-sync
  re-check; fixed by splitting the outcome into `synced` vs
  `already_synced`, only the former is audit-worthy), correct
  `meta_sync_pending`/`meta_sync_error`/notification on a real Graph API
  failure, and `retryPendingMetaSpendCapSyncs()` correctly picking up and
  retrying the pending row. The real account was fully restored afterward
  (Meta `spend_cap` and the three sync-state columns back to their exact
  pre-test values); the throwaway account was deleted. The banner + "Retry
  sync" button on the ad account detail page were also visually verified in
  a real (headless) browser against a logged-in admin session — screenshots
  confirmed the red banner, error text, and button render correctly and
  that clicking it round-trips through `retryMetaSpendCapSyncFn` with the
  correct toast.
- **"Spent Amount" column on the ad account detail page's Assignment
  History (post-Phase-8 addition): done, pending owner review** —
  `closing_limit_usd − opening_limit_usd` per assignment period
  (decimal.js), placed after Closing. Requested as "opening − closing"
  literally, but built as closing − opening instead: limits only ever grow
  during an assignment, so the literal formula would show a negative number
  on nearly every real row. Shows `—` for the currently-active (not yet
  released) assignment, same as the existing Closing column already does.
- **"Limit Requests" tab on the client detail page (post-Phase-8 addition):
  done, pending owner review** — inserted between Adjustments and Logins
  (`... | Adjustments | Limit Requests | Logins | Employees`). New
  `listClientLimitRequestsFn` (`limit-request.fns.ts`,
  `LIMIT_REQUESTS_VIEW`) mirrors the ad account Usage tab's fn, scoped to a
  client instead of an account: every **APPROVED** request for one
  `client_id` across every ad account they've ever held,
  most-recent-approval-first — a plain activity feed, matching the
  Adjustments tab's newest-first convention (Usage originally sorted
  ascending as a running trail to the current limit; both now sort the
  same way, descending, after the Usage tab's order was flipped
  2026-08-30 on owner request — see that entry above). Columns:
  Account (links to the ad account detail page) / USD (`approved_amount_usd`)
  / Date. Date is a custom format the owner specified literally —
  `08:00pm, 7 april 2026` (zero-padded 12h time + lowercase am/pm, then day
  + lowercase full month name + year) — not an `Intl.DateTimeFormat` preset,
  so a dedicated `fmtApprovalDateTime()` was written for it, driven by
  `approved_at` (not `requested_at`), matching the owner's "time will be
  based on approval time" instruction. Verified live against both real
  clients with approval history: `CL-0002` (7 approved requests across 4
  accounts) and `CL-0003` (3 approved requests, one account) — correct
  accounts, amounts, and formatted dates on every row.
- **`reset_all_data()` now clears employees too (post-Phase-8 addition):
  pending owner review, migration NOT YET APPLIED to the live project** —
  closes the orphaning gap documented above in the Employees+Delete entry.
  Migration `20260723000014_reset_includes_employees.sql`
  (`create or replace function`, same file pattern as the original
  `…0008_reset_function.sql`) adds `public.employees` to the `TRUNCATE …
  CASCADE` list (`client_employees` already cascaded correctly via its FK
  to `clients`; only `employees` itself, which has no such FK, was
  surviving) and resets `employee_code_seq` alongside the other document
  counters. `ResetDataDialog`'s confirmation text updated to mention
  employees. **Owner must apply this migration via the SQL editor or
  `supabase db push` before the next "Clear all data" run** — no DB
  connection is available in this dev environment to apply it directly.
- **Client-portal profile editing (post-Phase-8 addition): done, pending
  owner review** — closes the spec §9 gap where `portal/profile/index.tsx`
  was a hardcoded "later phase" stub with zero write capability. Scope:
  **full name only**. New, dedicated `updateMyProfileFn`
  (`src/server/profile/profile.fns.ts`) rather than a relaxed call into the
  admin-side `updateClientUserProfileFn` — that fn is `requireAdmin()`-gated
  and also force-confirms email changes via
  `admin.auth.admin.updateUserById(..., { email_confirm: true })` with no
  verification step, which is fine for a trusted admin fixing someone's
  login but not safe to expose to self-service. The new fn is
  `requireClientMembership()`-gated instead, touches only
  `user_profiles.full_name`, and derives the target `user_id` exclusively
  from the caller's own session (`actor.id`) — never accepted as input, so
  a client can only ever edit their own row. Email editing is explicitly
  out of scope (needs a real re-verification flow, a separate concern —
  same "out of scope for now" treatment as password reset on the admin-side
  edit-login feature). New `src/schemas/profile.ts`
  (`myProfileUpdateSchema`, name-only). UI: an "Edit" button on the
  Account card opens `EditProfileDialog` (React Hook Form + Zod, mirrors
  `EditLoginDialog`/`AddTeamMemberDialog`'s existing pattern), toast on
  success/failure, and `router.invalidate()` on success since the signed-in
  name lives in root route context (loaded once at `beforeLoad`) rather
  than a query — needed so the header's name/avatar refresh immediately
  instead of only after a manual reload. Audited as `PROFILE_UPDATED` /
  `entityType: 'USER'` / `metadata.source: 'CLIENT_SELF_SERVICE'` (same
  `entityType: 'USER'` convention already used by the admin-side user
  management fns, not `'CLIENT'`, since this isn't scoped to any one client
  relationship).
  **Verified live end-to-end**, not just typecheck/build: no chromium-cli
  or Playwright was available in this environment, so Playwright + a
  headless Chromium were installed on demand (`npx playwright install
  chromium`, browser cached under `~/.cache/ms-playwright`; the `playwright`
  npm package itself installed into this repo via `npm install --no-save`
  so it never touched `package.json`/the lockfile, and was uninstalled again
  after). Logged in as a real client login (`sabbir@gmail.com`, CL-0002 "DF
  IT Solutions") against a **local dev server pointed at the real
  production Supabase project** (nothing had been deployed to Vercel yet at
  verification time) — a Supabase magic link was generated server-side via
  the service-role key, then exchanged for an access/refresh token pair via
  a manual `fetch` against the verify endpoint (`redirect: 'manual'`,
  reading the token pair from the redirect's hash fragment) and turned into
  a real session cookie using the app's own `@supabase/ssr`
  `createServerClient` cookie-writing logic (guarantees byte-identical
  cookie format to what the app's own `getSupabaseServerClient()` expects
  to read), fed into the browser context via
  `context.addCookies()` — chosen after the more obvious approach (driving
  the existing client-side `/reset-password` hash-consuming page with
  Playwright) turned out not to reliably establish the SSR-readable cookie
  in a headless run. Confirmed: name showed "sabbir@gmail.com" before
  editing, "Edit" → change to "Sabbir Verified Test" → save → success toast
  → name updates immediately in both the Account card and the header
  avatar (proving the `router.invalidate()` refresh works), **survives a
  full hard-navigation reload** (proving real server-side persistence, not
  optimistic UI state), zero console errors throughout. Cross-client
  isolation independently confirmed via a read-only DB check: the edited
  user's `user_profiles.full_name` changed and *only* that row changed —
  the other login on the very same client (CL-0002) and the login on a
  different client (CL-0003) were both byte-identical to before. The
  `PROFILE_UPDATED` audit row was also inspected directly and matches
  exactly (`entity_id` = the editing user, correct `actor_user_id`, correct
  `metadata.source`). The test account's name was deliberately left as
  "Sabbir Verified Test" rather than reverted, per instruction.
- **DB-backed integration settings (post-Phase-8 addition): done, pending
  owner review, migration NOT YET APPLIED to the live project** — closes a
  real gap: environment variables can't be live-updated from application
  code on any serverless platform (Vercel included) — they're baked in per
  deployment, only take effect on the next build/cold start. So "add a
  Settings-page field that updates the environment" isn't literally
  buildable; the actual fix is to move the value out of env vars into the
  database, which genuinely can be updated live with no redeploy. Scope:
  the three Meta credentials (`META_SYSTEM_USER_TOKEN`, `META_BUSINESS_ID`,
  `META_API_VERSION`).
  New table `app_settings` (migration `20260723000015_app_settings.sql`,
  key/value, `updated_by`/`updated_at`) — deliberately **zero RLS policies**
  for `authenticated`, unlike every other table in this app (which get
  SELECT-only policies): this table can hold a live secret (the Meta System
  User token), so it must only ever be reachable through the service-role
  server layer, never queried directly from an authenticated browser
  session. New sensitive permission `integrations.manage` (SUPER_ADMIN by
  default, same treatment as `exchange_rate.manage`/`users.manage` — an
  ADMIN can still be granted it individually via the existing Users
  screen).
  `src/server/meta/meta.server.ts`'s `getMetaConfig()` now checks
  `app_settings` first, falling back to env vars per-field when a key has
  no DB row — env vars remain the out-of-the-box default, this is additive.
  Resolved once per top-level operation (`fetchMetaAdAccount`,
  `listMetaBusinessAdAccounts`, `updateMetaAdAccountSpendCap`) and threaded
  through to the internal `graphGet`/`graphPost` helpers, rather than
  re-querying the DB on every low-level Graph API call.
  **Safe against the migration not being applied yet**: the `app_settings`
  query's error is deliberately not thrown — a missing-table error (or any
  other query failure) falls straight through to the env-var fallback,
  logged via `console.error` for visibility rather than breaking every Meta
  feature. Verified live against the actual current (pre-migration) project
  state: `app_settings` query returns `PGRST205 — Could not find the table
  'public.app_settings'`, confirming this exact fallback path is what's
  running right now, with zero change to existing Meta behavior.
  New `src/server/settings/settings.fns.ts`: `getIntegrationSettingsFn`
  returns per-field status (`configured`, `source: 'database' | 'env' |
  'unset'`, and a `preview` — masked to the last 4 characters for the
  token, shown in full for business id / API version since those aren't
  credentials) — the raw token is never sent to the browser, not even
  after saving. `updateIntegrationSettingsFn` upserts only the fields
  actually provided (a blank field means "leave unchanged," since the form
  never prefills the real current value); `clearIntegrationSettingFn`
  deletes one field's DB row, reverting it to the env-var default. Neither
  write logs the raw secret value in the audit trail (`INTEGRATION_
  SETTINGS_UPDATED`/`_CLEARED`, `entityType: 'APP_SETTINGS'`) — only which
  field changed. UI: a new "Meta integration" card at the top of
  `/admin/settings` (above the existing Danger Zone), gated on
  `integrations.manage`, showing each field's status/source/masked preview
  with a "Clear override" action, and an "Edit" button opening
  `EditIntegrationSettingsDialog` (RHF + Zod, all fields optional and
  always blank on open, mirrors the existing dialog pattern).
  **Confirmed applied to the live project** — the owner's own screenshot of
  the working Settings card (real data, correctly labeled "Environment
  variable" source on all three fields, no error) is what confirmed this,
  not a check from this dev environment (which still has no DB connection).
  **Real bug found from that same screenshot and fixed the same session**:
  the Business Portfolio ID field showed autofilled with the owner's own
  email address (`mehedi.h.prantoz@gmail.com`) — Chrome's autofill/password-
  manager heuristics routinely ignore `autocomplete="off"` and fill a
  saved value into whatever text field sits near a password field; saving
  that unnoticed would have silently overwritten a working Business ID
  with garbage. Fixed two ways: (1) format validation added to
  `meta_business_id` (digits only) and `meta_api_version` (`v\d+(\.\d+)?`)
  in `integrationSettingsUpdateSchema` — a hard backstop that rejects
  autofilled garbage regardless of what the browser does, verified
  directly against the exact autofilled value from the screenshot (now
  rejected) alongside blank-submit and valid-value cases (still accepted).
  This also surfaced and fixed a **latent, unrelated bug**: the original
  schema used `.min(1).optional()` per field, but `.optional()` only skips
  validation for `undefined` — an actually-submitted empty string (the
  form's normal "leave unchanged" state) would have failed `.min(1)` and
  blocked the form from submitting at all whenever any field was left
  blank; switched to `z.union([z.literal(''), <real-value-schema>]).optional()`
  for all three fields. (2) Swapped `autocomplete="off"` for the
  higher-success-rate tricks browsers actually respect:
  `autocomplete="new-password"` on the token field,
  `autocomplete="one-time-code"` on the other two, plus `autocomplete="off"`
  on the `<form>` itself.
- **"Fetch"/"Refresh" now also sync the ad account name from Meta
  (post-Phase-8 addition): done, pending owner review** — closes a real gap
  the owner reported: renaming an account in Meta Business Manager and then
  clicking "Fetch" on the detail page (or "Refresh" on the list page) did
  nothing to our stored name. That's because name auto-sync only ever
  existed in the once-daily background cron (`meta-sync.server.ts`'s
  `syncMetaAdAccounts()`) — no manual action applied it, and the "Meta live
  data" card doesn't even display Meta's name to notice the mismatch by eye.
  Extracted the cron's inline rename-if-different logic into a shared,
  exported `syncAdAccountName(accountId, currentName, metaName, actorUserId,
  source)` in `meta-sync.server.ts` (same safe, non-financial, no-
  confirmation-needed semantics as the cron's own auto-rename — renaming
  carries no billing risk, unlike spend-cap writes). New
  `syncAdAccountNameFn` (`meta.fns.ts`, `AD_ACCOUNTS_MANAGE`) takes the
  already-fetched Meta name from the caller rather than re-fetching it
  server-side (avoids a redundant Graph API call on every Fetch click; no
  worse a trust boundary than the existing manual "Rename" dialog, which
  already lets an admin set an arbitrary name with zero Meta verification).
  Audited as `AD_ACCOUNT_RENAMED` with a new `metadata.source:
  'META_MANUAL_SYNC'`, distinct from the cron's `'META_SYNC'` so the audit
  trail can tell the two triggers apart.
  Wired into both existing entry points: the ad account detail page's
  "Fetch" button (`$accountId.tsx`) now compares the just-refetched live
  Meta name against the just-refetched stored name and applies the sync if
  they differ, refetching the account again afterward so the new name shows
  immediately (page title included) — success toast distinguishes a plain
  fetch from one that also renamed. The ad accounts list page's "Refresh"
  button (`index.tsx`) does the bulk equivalent — compares every linked
  account's Meta name against its stored name in one pass, syncs all
  mismatches in parallel, and reports how many were renamed.
  **Verified live** against a real linked account (`ADA-0026`, external id
  `963630549557499`): confirmed its live Meta name still matched our stored
  name (`"DF IT - Darun Food 03"`), so — to actually exercise the fix
  rather than a no-op — temporarily set our own stored name to a stale
  placeholder (a safe, local-only DB change; nothing was renamed on Meta's
  side), then ran the sync logic against the account's real live Meta data:
  correctly detected the mismatch, restored the name to
  `"DF IT - Darun Food 03"`, and wrote a correct `AD_ACCOUNT_RENAMED` /
  `metadata.source: 'META_MANUAL_SYNC'` audit row. (Couldn't import
  `meta-sync.server.ts` directly into a standalone script for this — it
  depends on `import.meta.env`, which only exists inside the Vite/TanStack
  Start runtime — so the DB-write half of the function was exercised via an
  exact mirror of its body instead; the comparison/routing half was already
  proven correct via the real `fetchMetaAdAccount` Graph API call earlier in
  the same check.)
- **Client detail page's Ad Accounts tab: added Current balance / Per USD /
  Remaining / Meta Due columns (post-Phase-8 addition): done, pending
  owner review** — that table only had Code / Account / Current limit /
  Status; the owner asked for the same figures already shown on the admin
  ad accounts list page. Three of the four needed **no new query** — the
  existing `listClientAccountsFn` already returns each account's own
  `usd_rate` (→ Per USD) and the client's ledger-derived due via
  `client_financials()` on `current_client.current_due` (→ Current
  balance, same value on every row here since the whole tab is scoped to
  one client); Current limit was already a column. Only Remaining/Meta Due
  needed new data — wired in the same bulk `listMetaBusinessAdAccountsFn`
  fetch (two Graph API calls total) and the identical
  `balanceByAccountId`/threshold/red-highlight logic already used on the
  admin list page, gated on `ad_accounts.manage` the same way. Verified
  live against a real client (CL-0002, "xRush Agency"): usd_rate/
  current_limit_usd/current_due all resolve correctly for its one active
  account. Follow-up: added the same single/double red `Bell` next to the
  account name that the admin ad accounts list page has (low remaining /
  high Meta Due), reusing the exact same `balance?.low` /
  `balance?.metaDueHigh` render block — this tab now has full parity with
  the list page's Meta-derived signals, just scoped to one client's
  accounts instead of every account.
- **Atomic payment submission (post-Phase-8 addition): done, pending owner
  review, migration NOT YET APPLIED to the live project** — a security
  audit found `submitPaymentFn`'s overpayment guard (spec §49) was a
  classic TOCTOU race: it checked "amount ≤ due − pending payments" via
  two plain `SELECT`s in application code, then inserted the payment
  afterward with no row lock or transaction tying the read to the write.
  Two concurrent submissions from the same client (a script, or even an
  accidental double-click) could both read the same pre-insert snapshot
  and each independently pass the guard, letting a client stack multiple
  full-amount `PENDING` payments beyond their real outstanding due — each
  one individually indistinguishable from a legitimate payment (own proof,
  own row), risking over-crediting the ledger if an admin approved more
  than one without noticing they were duplicative. Every *other* atomic
  multi-step financial write in this app (`approve_payment`,
  `approve_limit_request`, assign/release/transfer) already goes through a
  row-locked `SECURITY DEFINER` RPC — this was the one place that should
  have but didn't. Fixed with a new `submit_payment` RPC (migration
  `20260723000016_atomic_submit_payment.sql`) that locks the client row
  (`select ... for update` on `clients`) before computing due/pending and
  inserting, mirroring `client_financials()`'s debit-minus-credit formula
  directly rather than calling it (already inside the lock). Raises
  `OVERPAYMENT: ...` on failure, unwrapped by the existing
  `friendlyRpcError()` convention (same pattern as `STALE_BASELINE`).
  `submitPaymentFn` now just calls the RPC and proceeds to the existing
  proof-upload/rollback step; the admin-approval side (`approve_payment`)
  is deliberately untouched — it stays override-capable by design, this
  fix only closes the client-side submission race, not admin discretion at
  approval time. **Owner must apply this migration via the SQL editor or
  `supabase db push`** — no DB connection is available in this dev
  environment to apply it directly.
- **Telegram notifications for 3 events (post-Phase-8 addition): done,
  pending owner review, migration NOT YET APPLIED to the live project** —
  a client submitting a limit request, an ad account being disabled on
  Meta, and an ad account crossing the low-remaining-balance threshold
  (the latter two only detectable via the daily `/api/cron/meta-sync` job,
  which previously only handled renames + counting new unlinked accounts —
  it never looked at `meta_status_code` or spend headroom at all). New
  `sendTelegramMessage()` (`src/server/telegram/telegram.service.ts`),
  best-effort like the existing in-app `notify()` (never throws to the
  caller, never blocks the operation it's attached to), no-ops silently
  when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` aren't configured — same
  "optional integration, degrades gracefully" pattern the Meta integration
  itself started with. **Deliberately called only from these 3 specific
  event sites**, not wired into `notifyAdmins()`/`notify()` globally —
  every other admin notification (payments, adjustments, etc.) stays
  in-app only, on purpose, so Telegram doesn't get flooded.
  Event 1 (limit request submitted): one extra line in the existing
  `createLimitRequestFn`, right after its existing `notifyAdmins()` call —
  reused the account row already being fetched for validation (extended
  its `select` to also grab `account_code`/`name`) plus one small new
  `clients.name` lookup, so the message reads "Client X requested $Y on
  ADA-000N" rather than bare ids.
  Events 2 & 3 (disabled / threshold crossed) needed real new logic in
  `syncMetaAdAccounts()` (`meta-sync.server.ts`): both must fire **once per
  transition**, not re-alert every single day the account stays in that
  state (the cron runs daily — `vercel.json`'s actual schedule, `"0 3 * *
  *"`; CLAUDE.md's older "every 6h" phrasing elsewhere was stale and left
  uncorrected outside this entry). New `ad_accounts.meta_last_status_code`
  / `meta_low_balance_alerted` columns (migration
  `20260723000018_meta_alert_state.sql`) persist what the cron last saw
  per account so `checkAdAccountAlerts()` (a pure comparison function) can
  tell "still disabled" apart from "just became disabled", and reset the
  low-balance flag once an account recovers above threshold so the next
  crossing alerts again. "Threshold" reuses the existing
  `LOW_BALANCE_THRESHOLD` (≤60, USD-only currency-native gate, same as the
  display bell) rather than inventing a second definition of "low" — owner
  confirmed this explicitly rather than assuming. Deliberately did **not**
  add new audit-log entries for these two — audit entries are for changes
  to our own data (like the existing rename audit), and these two are pure
  external-signal detection with no data of ours changing beyond the
  internal tracking columns. Did extend the existing "Meta Business
  Portfolio sync" in-app digest notification to also mention
  disabled/low-balance counts when they occur (it already existed and
  already summarizes "what happened this sync" — leaving it silent about
  two new categories of thing that can happen would make it misleading,
  not just incomplete). All 45 existing tests, typecheck, and build pass
  unchanged. **Owner must apply the new migration via the SQL editor or
  `supabase db push`, and set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`** (a
  bot created via @BotFather, and the numeric chat id of whoever/wherever
  should receive these — a DM chat or a group the bot's been added to) —
  no DB connection or Telegram credentials are available in this dev
  environment to apply/test this directly.
- **"External ID" renamed to "Ad account ID", required on create
  (post-Phase-8 addition): done, pending owner review** — display label
  only (create/edit dialogs, detail page's Account details card); the
  underlying `external_account_id` field/column is unchanged. Per owner
  instruction ("not optional from today"), it's now required when
  **creating** a new ad account — enforced in both the create dialog's Zod
  schema and, the actual boundary that matters, the server-side
  `adAccountCreateSchema` (`src/schemas/ad-account.ts`). Deliberately left
  optional on `adAccountUpdateSchema`/the edit dialog, so editing any
  account created before today isn't blocked on backfilling this field.
- **Removed the mandatory "limit update proof" requirement from approval
  (post-Phase-8 addition): done, pending owner review** — this proof was
  never a client artifact: `uploadLimitProofFn` is `requireAdmin`-gated and
  the client's own submission form (`limitRequestCreateSchema`) has no
  proof field at all, so it was always the *admin's* own evidence,
  almost certainly a screenshot of manually updating the spend cap on Meta
  before approving. The "Auto-push approved limit increases to Meta
  spend_cap" feature (already shipped) made that manual step obsolete, so
  the owner asked to remove it. Dropped both the server-side check in
  `approveLimitRequestFn` (spec §29's rule) and the upload/replace UI on
  the admin approval screen (`/admin/limit-requests/$requestId`); "Proof
  attached ✓ View" stays but only renders when a historical request
  already has one attached — nothing can attach a new one anymore, so it
  no longer shows a permanent "no proof attached" for every future
  request. `uploadLimitProofFn`/`proofUploadSchema`/`getLimitProofUrlFn`
  still exist (the latter still used for viewing old proofs) — see the
  Phase 3 conventions note above for the "superseded" detail.
  **Caught mid-implementation**: the first pass (remove only the upload
  button, keep the server-side check) would have permanently blocked
  approval on every future request, since nothing left in the app could
  ever satisfy that check again — fixed before shipping, not after.
- **Client segmentation (prepaid/postpaid) with partial prepayment for
  limit requests (post-Phase-8 addition): done, pending owner review,
  migration NOT YET APPLIED to the live project** — every client now has a
  `segment` (`prepaid` | `postpaid`, new `clients.segment` column, required,
  no DB default — the app must always supply it explicitly on insert; set
  at creation via `ClientFormDialog`, editable later like any other client
  field). Existing clients backfilled to `postpaid` (their real behavior to
  date). Segment is looked up **server-side** in `createLimitRequestFn` —
  never trusted from the client payload, so a postpaid client can't submit
  prepaid-looking fields to bypass anything.
  **Prepaid**: `RequestLimitDialog` shows a read-only "Total cost" preview
  (`requested_amount_usd × rate`, `multiplyUsdByRate`, same rounding
  `approve_limit_request` uses) plus an "Amount paid (BDT)" input
  pre-filled with the full cost but **editable down** — partial payment is
  allowed, unlike the discarded all-or-nothing design below. A live
  "Fully paid" / "Due balance: ৳X" preview updates as the client types.
  Payment proof is required to submit. Server-side: `total_cost_bdt` is
  computed fresh (never trusts a client-submitted value), `amount_paid_bdt`
  is validated `0 < amount_paid ≤ total_cost`, `due_balance_bdt =
  total_cost − amount_paid` is computed server-side too.
  **Postpaid**: unchanged from the app's original behavior — no payment or
  proof fields shown, no validation of them even if present in the
  payload (simply never read), full amount becomes due, settled later via
  the existing Pay Due flow.
  New `limit_requests` columns: `segment` (snapshotted per-request, not a
  live join — a client's segment changing later never rewrites past
  requests), `total_cost_bdt` (frozen at submission, distinct from the
  existing `bdt_charge` which is computed at *approval* from the
  admin-editable amount/rate), `amount_paid_bdt`, `due_balance_bdt`.
  Historical rows backfilled as `postpaid` / `total_cost_bdt =
  requested_amount_usd × default_usd_rate` / `amount_paid_bdt = 0` —
  verified the backfill formula against all 5 real historical rows before
  writing the migration, all computed cleanly with no nulls.
  On approval, `approve_limit_request` now **auto-records a matching
  APPROVED `payments` row + `PAYMENT` ledger credit for `amount_paid_bdt`**
  (prepaid only, `if v_req.segment = 'prepaid' and
  coalesce(v_req.amount_paid_bdt, 0) > 0`) in the same atomic transaction
  as the existing `LIMIT_APPROVAL` debit — this can be a *partial* amount,
  so the shortfall naturally becomes real ledger due with no separate
  due-tracking mechanism needed (due is still purely `debit − credit`, as
  always). Postpaid requests get no auto-payment at all — debit only,
  exactly the original behavior. Return type changed from a bare `uuid` to
  `jsonb` (`ledger_id`, `payment_id`, `payment_ledger_id` — the latter two
  `null` for postpaid). `approveLimitRequestFn` (TS) links the client's
  already-uploaded proof to the new payment too when one was created.
  Migration `20260723000019_client_segment_prepayment.sql`.
  UI: segment badge + Total cost/Amount paid/Due balance shown on the
  admin approval detail page's Request card, and as new Paid/Due columns
  on the client's own Limit Requests list — that list's "View proof"
  button now shows whenever `segment === 'prepaid'` (proof exists from
  submission time now, not just after approval) instead of the old
  `status === 'APPROVED'` gate, which would have hidden it while pending.
  **Known caveat, flagged not defended against**: `total_cost_bdt`/
  `amount_paid_bdt` are frozen at submission; admins can still edit the
  approved amount/rate at approval time (unchanged, existing capability) —
  if they do, the auto-recorded payment reflects `amount_paid_bdt` as
  entered, which could then not exactly match the admin-approved figures.
  Both the debit and credit stay independently correct either way (no
  ledger-integrity bug), but it's a real-world reconciliation note worth
  knowing about.
  **Supersedes an earlier same-day, never-committed design** ("Client
  prepays for limit requests up front") that forced every client to
  prepay 100% with no partial option and no postpaid segment — nothing
  from that design was ever committed or deployed, so it was replaced
  outright here rather than layered on top of; see the CHANGELOG for the
  full before/after. **Confirmed applied to the live project** — a direct
  read of `clients`/`limit_requests` showed both `segment` columns already
  populated (`CL-0001` set to `prepaid`, everything else `postpaid`) before
  the three-way split below was built, superseding the "not yet applied"
  note this bullet originally had.
- **Split `prepaid` into `prepaid` (full, locked) and `partial` (editable,
  the original meaning) (post-Phase-8 addition): done, pending owner
  review, migrations NOT YET APPLIED to the live project** — segment is
  now three-way. `prepaid` clients must pay the full `total_cost_bdt` to
  submit a request; the "Amount paid" field is disabled in
  `RequestLimitDialog` (always shows/sends the full amount) and
  `createLimitRequestFn` ignores whatever `amount_paid_bdt` the payload
  carries for this segment, computing it itself as `totalCost` server-side
  regardless. `partial` keeps the exact behavior the entry above
  describes — editable amount, `0 < paid ≤ total`, remainder becomes due.
  `postpaid` unchanged. `approve_limit_request`'s auto-credit condition
  widened from `segment = 'prepaid'` to `segment <> 'postpaid'`.
  Two migrations, deliberately split:
  `20260723000020_add_partial_segment.sql` (bare `alter type ... add
  value 'partial'`, nothing else in the file — a newly-added enum value
  can't safely be used in the same transaction it's created in) and
  `20260723000021_prepaid_full_partial_split.sql` (data migration +
  `create or replace function`, no return-type change this time so no
  drop needed). **Found and correctly handled real live data before
  writing the migration**: queried `clients`/`limit_requests` directly and
  found `CL-0001` already set to the old `prepaid` meaning, and its
  already-approved `LR-000012` with a genuine partial payment (৳1,522 of
  ৳13,000) — both remapped to `'partial'` in the migration so their
  semantics don't silently change under the new stricter `prepaid`
  definition. UI: 3rd Select option + updated helper text on
  `ClientFormDialog`, 3-state segment badge (emerald/amber/muted) on the
  admin approval page, portal Limit Requests list's Paid column and
  "View proof" button both switched from `segment === 'prepaid'` to
  `segment !== 'postpaid'` so partial clients keep showing correctly.
  **Owner must apply both migrations via the SQL editor or `supabase db
  push`** — no DB connection is available in this dev environment to
  apply them directly (though I do have read-only access via the
  service-role key, used here to confirm the real data before migrating
  it).
- **"Total Remaining" summary card on the client detail page (post-Phase-8
  addition): done, pending owner review** — a 6th card in
  `FinancialSummary` (`src/components/shared/financial-summary.tsx`),
  placed right after "Current Due (USD, approx.)" per the owner's request,
  summing Meta spend headroom (`spend_cap − amount_spent`) across the
  client's own linked ad accounts. USD-only, no FX conversion — same
  currency-native gate `LOW_BALANCE_THRESHOLD`/`META_DUE_THRESHOLD` already
  use. New optional `totalRemainingUsd` prop; `null`/omitted hides the card
  rather than showing a misleading "$0.00" (used only when
  `ad_accounts.manage` is granted and the bulk Meta fetch has resolved) —
  the portal statement page's own `FinancialSummary` usage doesn't pass it,
  so it's unaffected, still 5 cards. Computed client-side in
  `$clientId.tsx` from the same `balanceByAccountId` map the Ad Accounts
  tab's per-row Remaining column already builds — no new query added.
- **"Remaining" column on the clients list page (post-Phase-8 addition):
  done, pending owner review** — the same figure one level up:
  `/admin/clients` (`admin/clients/index.tsx`) now shows each client's
  summed Meta spend headroom across their linked USD ad accounts. No new
  server fn: reuses the existing bulk `listAdAccountsFn` (each
  `AdAccountWithClient` row already carries `current_client.id`, resolved
  server-side by `currentClientMap()`) joined client-side against the
  existing bulk `listMetaBusinessAdAccountsFn` fetch (the same call the ad
  accounts list page and the client detail page's Ad Accounts tab already
  make) — grouped by `current_client.id` instead of by account. Gated on
  `PERMISSIONS.AD_ACCOUNTS_MANAGE` (`canManageMeta`), separate from the
  page's existing `CLIENTS_MANAGE`-based `canManage` (which only controls
  the delete-dropdown) — matching the permission the Meta query itself
  requires server-side. USD-only, no FX path, same as every other
  Meta-money figure in this app. Shows `—` per client when no data is
  available (permission missing, Meta unconfigured, or no linked USD
  accounts) rather than a misleading `$0.00`.
- **"Total Remaining" card on the client portal dashboard (post-Phase-8
  addition): done, pending owner review** — the same figure surfaced to
  clients: `/portal` (`portal/index.tsx`) now shows a "Total Remaining"
  card immediately after "Current Due (USD, approx.)" (appended right
  after the existing `SUMMARY_CARDS` map, whose last entry already is that
  card, so it lands in the requested position without touching the
  `ClientDashboardStats`-keyed array). No new server fn — reuses the
  existing `listMyAccountsMetaRemainingFn` (`meta.fns.ts`, already gated by
  `requireClientMembership()` and already powering `/portal/ad-accounts`'s
  per-row "Remaining" column), summed client-side over USD-currency,
  non-null entries only (`currency !== 'USD'` or `remaining == null` are
  skipped — same no-FX, currency-native rule as every other Meta-money
  aggregate in this app). The card is omitted entirely (not rendered as
  `$0.00`) until the query resolves — degrades the same way the ad-accounts
  page's own Remaining column already does when Meta is unreachable or
  unconfigured.
- **Brand identity applied via theme CSS variables (post-Phase-8 addition):
  done, pending owner review** — replaced shadcn's default gray palette
  with a real brand system: Ink `#14171C` (sidebar/header/dark surfaces),
  Canvas `#F7F6F2` (page background), Brand Primary `#C98A2C` (buttons,
  active nav, CTAs), Brand Deep `#8F5F17` (hover/pressed on primary
  elements), Accent teal `#0E7C86` (links, chart colors). All five live as
  named tokens (`--brand-ink`, `--brand-canvas`, `--brand-primary`,
  `--brand-primary-deep`, `--brand-accent`) at the top of `src/styles.css`
  and every shadcn variable derives from them — no bare hex repeated
  in-place, and no color hardcoded into individual components.
  `--primary-foreground` is set to Ink rather than white — computed
  contrast against Brand Primary is ~6.5:1 with Ink text vs. ~2.9:1 with
  white, so white would have failed WCAG AA on every primary button.
  A new `--primary-hover`/`--color-primary-hover` token (Brand Deep) was
  added so `Button`'s and `Badge`'s default variants use the real hex on
  hover instead of the previous `hover:bg-primary/90` opacity trick.
  **Also removed, in the same file**: an entirely unused leftover "ocean"
  template theme (`--sea-ink`, `--lagoon`, `--palm`, `--sand`, `--foam`,
  `.island-shell`, `.feature-card`, `.nav-link`, `.site-footer`,
  `.display-title`, decorative `body::before`/`::after` radial-gradient
  layers) — confirmed via repo-wide grep that none of those classes or
  variables were referenced by any route or component; the `body` rule
  itself was rewritten to actually use `--background`/`--foreground`
  (previously it read a separate, disconnected set of ocean-template
  variables, so changing the real shadcn tokens alone would have produced
  no visible change at all).
  **Sidebar/header wired to the (previously unused) `--sidebar*` token
  family** — `AppShell`, `Header`, `SidebarNav`, and the mobile nav `Sheet`
  didn't reference `--sidebar`/`--sidebar-foreground`/etc. before this pass
  (they used plain `bg-background`); now they do, giving the chrome a
  constant Ink-dark look independent of the (currently untoggleable —
  no `ThemeProvider`/`next-themes` found anywhere in the app; the `.dark`
  CSS block and every `dark:` utility class in components are inert dead
  code today) light/dark mode. Active nav state uses `--sidebar-primary`
  (Brand Primary, solid pill) rather than the generic `--accent`, since
  repointing `--accent` itself to teal would have also turned every
  `hover:bg-accent` surface app-wide (dropdown items, tabs, select, ghost
  buttons) solid teal — confirmed via grep just how many places consume
  `--accent`, and kept it a subtle neutral instead.
  **Deliberately left untouched**: `--destructive` (a distinct concept
  from due/urgency status, already an appropriate red) and every hardcoded
  status color — `StatusBadge` (`src/components/shared/status-badge.tsx`)
  was inspected directly and confirmed to always render `variant="outline"`
  with its own literal per-status Tailwind classes (`bg-emerald-100
  text-emerald-800`, `bg-red-100 text-red-800`, etc.), never reading any
  theme variable — same for the `text-red-600`/`text-emerald-600 dark:...`
  literals used for due-amount urgency, low-balance bells, and Meta Due
  alerts throughout the admin/portal pages. None of it touches `--primary`
  or `--accent`, so none of it was at risk from this pass, confirmed by
  inspection rather than assumed.
  **Explicitly out of scope for this pass**: the internal `text-primary`
  used for record-navigation links inside individual page tables (client
  names, ad account names, etc. across dozens of route files) still
  renders Brand Primary amber, not Accent teal — retargeting those would
  mean editing className strings file-by-file rather than a shared
  variable, which the owner's instructions explicitly deferred ("start
  with shared layout/theme variables first, verify visually, then move to
  individual pages if anything doesn't inherit correctly").
  **Verified visually against the live app**, not just typecheck/build:
  temporary Playwright + magic-link session injection (same technique
  documented in the client-portal-profile-editing entry above — the
  `playwright` npm package installed via `npm install --no-save` and
  removed again after, confirmed zero `package.json`/lockfile diff)
  against a real ADMIN test account (`test@gmail.com`) and a real client
  login (`quickranksolutions@gmail.com`, CL-0003 "DF IT Solutions").
  Screenshotted the admin dashboard, ad accounts list, a client detail
  page (which also exercises the new "Total Remaining" card from the
  entry above), and the client portal dashboard — confirmed Ink sidebar/
  header with amber active nav and CTAs, teal links, and all red/emerald
  status coloring (due amounts, "Active" badges, low-balance bells,
  negative Remaining figures) rendering exactly as before, untouched.
- **Brand-colored table row hover (post-Phase-8 addition): done, pending
  owner review** — a direct follow-up to the brand-identity pass above.
  `TableRow` (`src/components/ui/table.tsx`), the one shared primitive
  behind every table in the app, now hovers with `bg-accent/50` (soft
  amber) plus a `border-l-2 border-l-link` teal accent stripe, replacing
  the generic `hover:bg-muted/50`/`data-[state=selected]:bg-muted`. Touched
  once, in the shared component, so every list page inherited it —
  consistent with the "shared layout/theme first" scoping the owner set for
  the branding pass itself. Also registered a new `--color-link` token in
  `@theme inline` (`src/styles.css`) — Accent teal previously only existed
  as the bare `a { color: var(--link) }` rule, with no Tailwind utility
  (`text-link`/`border-link`/etc.) able to reach it; this is what the hover
  stripe uses. Verified visually: a Playwright screenshot with a row
  hovered on the live ad accounts list confirmed the tint/stripe render
  correctly and the in-row red/emerald status colors are unaffected.
- **Fixed: a login email couldn't be added to more than one client
  (post-Phase-8 addition): done, pending owner review, migration confirmed
  applied to the live project** — both `createClientUserFn` (admin "Add
  login") and `addTeamMemberFn` (client-portal self-service "Add
  teammate") unconditionally called `admin.auth.admin.createUser(...)`,
  which fails with "A user with this email address has already been
  registered" the instant that email exists anywhere in `auth.users` —
  even though `client_memberships` was already schema-designed for one
  login belonging to several clients (`unique(user_id, client_id)`, not
  `user_id` alone — confirmed by reading the original Phase 1 migration).
  The "Edit login profile + membership status" entry above already noted
  this was "theoretically possible, not yet a real case"; it became a real
  case. New shared `provisionClientLogin()`
  (`src/server/clients/client-login.server.ts`), used by both fns: looks
  the email up first via a new `find_auth_user_by_email` RPC (migration
  `20260723000022_find_auth_user_by_email.sql`, `security definer` +
  `grant execute ... to service_role` only, same pattern as every other
  privileged RPC — `auth.users` isn't reachable via PostgREST otherwise).
  If the email belongs to an existing **CLIENT**-role login, it's reused —
  a new `client_memberships` row is inserted, or an existing INACTIVE one
  is reactivated (rather than hitting the unique-constraint violation) —
  instead of erroring. If it belongs to ADMIN/SUPER_ADMIN staff, the
  request is refused with a clear message rather than silently linked:
  that account could never actually log into the portal anyway
  (`requireClientMembership()` rejects any non-CLIENT role), so reusing it
  would produce a membership row that's permanently useless. UI: both "Add
  login" dialogs (`add-login-dialog.tsx`, `add-team-member-dialog.tsx`) now
  toast "Existing login linked..." vs "...created" depending on which
  branch ran (both server fns' return type gained `reused_existing_user`
  for this), and the password field's helper text explains it's ignored
  when reusing an account.
  **Update, later same day: confirmed applied and working live** — the
  owner applied the migration and used "Add login" to link a real login
  (`mehedi.h.pranto@gmail.com`) to a second client ("Ahad Bhai", CL-0004);
  verified directly against the `audit_logs` row it produced
  (`CLIENT_USER_CREATED`, `metadata`-adjacent `new_values.
  reused_existing_user: true`). This immediately surfaced the next real
  gap — see the entry directly below.
- **Fixed: a login belonging to multiple clients only ever saw the first
  one's data (post-Phase-8 addition): done, pending owner review, no
  migration** — every portal server fn calls `requireClientMembership()`
  with no argument, and that guard used to hardcode `active[0]` as the
  default — whichever client happened to sort first in the session's
  membership query. So the multi-client-login fix immediately above
  successfully linked a second client but the portal had no way to ever
  show it: the dashboard, ad accounts, due, statement, everything always
  showed the first client, with the second one's badge appearing at the
  top of `/portal` purely as inert decoration (confirmed by inspection —
  no `onClick`, no `Link`, not wired to anything).
  Fixed with a small, low-blast-radius mechanism rather than threading a
  `clientId` through all ~20 `requireClientMembership()` call sites
  app-wide: a new `rt_active_client` cookie
  (`ACTIVE_CLIENT_COOKIE`, `src/lib/auth/types.ts`) holds which client is
  "current" for that login. New pure `resolveActiveClientId(active,
  cookieClientId)` (same file, unit tested in `types.test.ts`) picks the
  cookie's value **only if** it names one of the caller's own active
  memberships, otherwise falls back to the first one — never throws on a
  stale or foreign cookie value (e.g. a membership deactivated after the
  cookie was set). `loadSessionUser()` (`auth.fns.ts`) resolves this once
  per session load via `getCookies()` and puts it on the new
  `SessionUser.activeClientId` field. `requireClientMembership()`
  (`guards.server.ts`) now uses `user.activeClientId` for its no-argument
  default instead of the hardcoded `active[0]` — **every existing portal
  server fn needed zero changes**, since grepping confirmed none of the
  ~20 call sites across dashboard/limit-requests/payments/ledger/team/etc.
  ever passed an explicit `clientId` to begin with; they all rode the
  guard's default, so fixing the default fixed all of them at once. The
  explicit-`clientId` code path (cross-client isolation — the one that
  hard-`FORBIDDEN`s when the caller isn't actually a member of the
  requested client) is untouched.
  New `setActiveClientFn` (`src/server/auth/portal-session.fns.ts` — a new
  file, not added to `auth.fns.ts`, to avoid a circular import since
  `guards.server.ts` already imports `getCurrentUserFn` from `auth.fns.ts`)
  is the one new endpoint: re-validates the requested client server-side
  via `requireClientMembership(data.client_id)` — never trusts that a
  submitted `client_id` is actually one of the caller's own memberships —
  then writes the cookie.
  UI: `/portal`'s badge row (`portal/index.tsx`) is now a real switcher
  when `activeMemberships(user).length > 1` — click a client to switch,
  the current one shown highlighted/disabled, others clickable. On success
  it does a **hard navigation** (`window.location.assign('/portal')`), not
  `router.invalidate()` — every portal query's cache key is client-
  agnostic (e.g. `['client-dashboard-stats']`, no `clientId` in it), so
  only a full reload guarantees nothing from the previous client's data
  survives in the TanStack Query cache; a soft client-side nav would risk
  showing stale cached numbers from the client just switched away from.
  Also extended `portal/route.tsx`'s `areaLabel` to show the active
  client's name (`"{name} · Client Portal"`) on **every** portal page, not
  just the dashboard's switcher, so it's always visible whose data is on
  screen — this was the single-membership case's implicit context that
  multi-membership logins were missing entirely.
  **Verified live end-to-end** against the exact real account that
  surfaced the bug (`mehedi.h.pranto@gmail.com`, member of both "xRush
  Digital" CL-0001 and "Ahad Bhai" CL-0004) via the same temporary
  Playwright + magic-link session technique used elsewhere this session —
  before/after screenshots confirm genuinely different data on each side
  (different due amount — ৳11,478 vs ৳0 —, different linked ad account,
  different totals), not merely a relabeled header over an unchanged
  query result.
  **Known, deliberately out-of-scope gap, flagged not fixed**:
  `notifications` has no `client_id` column at all (confirmed directly —
  it's purely `user_id`-scoped per its own migration), so a multi-client
  login's notifications are shared across every client they belong to
  regardless of which one is "active" right now. This is a real design
  question (scope notifications per-client vs. keep them global across a
  person's whole login) that wasn't part of what was reported, so it was
  left alone rather than guessed at. **Closed the same day** — see the
  entry immediately below.
- **Notifications scoped to the active client (post-Phase-8 addition):
  done, pending owner review, migration NOT YET APPLIED to the live
  project** — closes the gap flagged directly above. New nullable
  `notifications.client_id` (migration
  `20260723000023_notifications_client_scope.sql`), populated only by
  `notifyClientMembers(clientId, ...)` (`notification.service.ts`) —
  the sole notification path that's inherently about one specific client
  (limit-request/payment approvals and rejections, adjustments,
  assignments). `notifyAdmins()` and every other admin-facing call leaves
  `client_id: null`, and admin notification reads are never filtered by
  it at all.
  **Two behaviors deliberately split, not both scoped the same way**:
  `unreadNotificationCountFn` (the header bell badge, `notification.fns.ts`)
  stays **global** — counts across every client a login belongs to,
  regardless of which is active. Scoping the count to the active client
  was considered and rejected: it would let a notification about a
  non-active client go completely unnoticed, with no signal to ever
  switch and check. `listMyNotificationsFn` (the list, both the header
  dropdown and `/portal/notifications`) and `markAllNotificationsReadFn`
  **do** filter to `client_id is null or client_id = <active client>` via
  `user.activeClientId` (from the client-switcher fix above) when
  `user.role === 'CLIENT'` — matching the scoping every other portal page
  now has. `markAllNotificationsReadFn` needed the same filter as the
  list for a reason beyond consistency: without it, "mark all read" on a
  page showing only the active client's notifications would silently
  clear unread ones from a client the user isn't even looking at.
  `markNotificationReadFn` (single-notification, by id) was left
  unscoped — it already matches by `id + user_id`, a specific row the
  caller already knows about, so there's no meaningful cross-client
  concern there.
  UI: `/portal/notifications`'s description swaps to "Updates for
  {client name} — switch clients from the dashboard to see another
  client's notifications" when a login has more than one active
  membership, so the filtering isn't silently invisible.
  **Migration NOT YET APPLIED to the live project** — no DB connection
  available in this dev environment to apply it directly. Unlike some
  other pending migrations in this doc, this one is **not safe to defer**:
  once this code ships, `listMyNotificationsFn`'s `.or('client_id.is.null,
  client_id.eq.<uuid>')` clause references a column that doesn't exist
  yet, so every CLIENT-role user's notification bell/list/page would
  start erroring immediately, not just silently miss the new scoping.
  Apply via the SQL editor or `supabase db push` before deploying this.
- **Fixed: a client's own USD rate was silently ignored — every ad account
  form forced a positive rate, making "inherit from client" unreachable
  (post-Phase-8 addition): done, pending owner review, no migration** —
  `adAccountUsdRate()` (`rate.service.ts`) has always correctly
  implemented the account-overrides-client fallback (account rate wins
  when set; falls back to `clientUsdRate()` when the account's rate is 0)
  — this was never broken. The bug was one layer up: every UI path that
  writes an ad account's `usd_rate` required it to be `> 0` — the account
  create/edit dialogs (`account-dialogs.tsx`) and their schemas
  (`schemas/ad-account.ts`), and the Meta bulk-import dialog's "default
  rate for imported accounts" field (`meta-import-dialog.tsx`,
  `schemas/meta.ts`) — so `0` (the documented "unset/inherit" sentinel)
  was never actually reachable from the UI. In practice this forced every
  admin to type *some* rate for every account (or once per import batch,
  applied to every account in it), permanently pinning that account away
  from ever following its client's own rate again.
  **Confirmed live, not just theorized**: queried every ad account
  currently assigned to a client — every single one has an explicit
  non-zero `usd_rate` (mostly `130`, matching the bulk-import dialog's old
  `130.00` placeholder — strong evidence most of these came from one
  import batch rather than individual entry), so a client's own configured
  rate has effectively never governed billing for any account created
  after per-account rates shipped. Two live accounts show the exact
  reported symptom: `ADA-0014` ("Foysal bhai" — client rate ৳129, account
  pinned at ৳130) and `ADA-0018` ("xRush Agency" — client rate ৳1, account
  pinned at ৳130).
  Fix: relaxed all four `usd_rate` validators (the two in
  `schemas/ad-account.ts` covering create+edit, the client-side duplicate
  in `account-dialogs.tsx`, and `schemas/meta.ts`'s bulk-import one) from
  `.gt(0, ...)` to `.min(0, ...)` / an equivalent non-negative check — 0/
  blank is now accepted and means what `rate.service.ts` already
  documented. Updated the labels/placeholders/helper text on all three
  dialogs to explain the inherit behavior explicitly (e.g. the import
  dialog's field relabeled "Rate override for imported accounts,
  optional," placeholder changed from `"130.00"` to "Leave blank to
  inherit each client's own rate"). Also fixed a small unrelated bug found
  while in this file: `AccountCreateDialog`'s on-open `form.reset()` was
  missing the `usd_rate` key, so a previously-typed value in that field
  could linger across dialog opens within the same session.
  **Left the two live mismatched accounts untouched, deliberately** —
  clearing an account's rate override changes what its future limit
  requests will actually bill at, so that's flagged for the owner to
  action via the now-fixed Edit dialog (clear "Per USD" to blank and
  save) rather than silently edited as part of a bug-fix pass.
- **Live verification pass + one more real bug found (post-Phase-8
  addition): done, pending owner review, no migration** — after the owner
  applied both pending migrations, every fix from earlier today was
  re-verified against the live app rather than trusted from static checks
  alone. Multi-client login (`find_auth_user_by_email`) and notification
  `client_id` scoping were both confirmed via **real writes**: a fresh
  payment request against a real client correctly produced a notification
  with `client_id` set; a second payment request against a different
  client belonging to the same real multi-membership login (from earlier
  switcher testing) was confirmed to appear in `/portal/notifications`
  only once the active client was switched to it, while the header's
  unread count badge stayed identical either way — proving the
  count-stays-global / list-follows-active-client split actually works,
  not just typechecks. All test payment requests, their notifications,
  and their audit rows were deleted afterward.
  **New bug found while verifying the USD-rate fix, unrelated to it**:
  `AccountEditDialog` (`account-dialogs.tsx`) and `ClientFormDialog`
  (`client-form-dialog.tsx`) both failed to save with **zero changes
  made** — "Invalid input: expected string, received number" on
  `current_limit_usd`/`usd_rate` (accounts) and `usd_rate` (clients).
  Confirmed this predates today's work — reproduced by opening a
  completely untouched dialog and clicking Save immediately. Root cause:
  both dialogs seed `defaultValues` directly from the numeric prop
  (`account.usd_rate`, `client.usd_rate`, etc.), but Supabase actually
  returns these `numeric` columns as JS **numbers** — contradicting this
  file's own documented convention ("NUMERIC columns come back from
  supabase-js as strings," noted under the Phase 2 conventions section)
  — while both dialogs validate with a `z.string()`-based schema that
  rejects a raw number. Fixed by wrapping each numeric default in
  `String(...)` in both dialogs' `useForm` initial `defaultValues` and
  their on-open `form.reset()`. This means **editing any existing ad
  account or client was silently broken before today**, independent of
  the USD-rate inheritance bug — a genuinely separate, more basic defect
  this verification pass happened to surface. Re-verified the USD-rate
  fix itself via a full round-trip through the real Edit dialog UI on a
  live, unassigned account (`ADA-0007`): cleared "Per USD" to blank,
  confirmed the DB value became `0`, then restored it to its original
  `130` — net-zero change, confirming the entire path (UI → schema →
  server fn → DB) genuinely works now, not just passes typecheck.
- **"Financial ledger" visual design system (post-Phase-8 addition): done,
  pending owner review, no migration** — a styling-only pass replacing the
  earlier amber/teal brand palette (see the "Brand identity" entries
  above) with a finance-grade look, per explicit owner spec. IBM Plex Sans
  (UI) / IBM Plex Mono (every numeric value — spend, balances,
  percentages, counts, via a new `.num` class /
  `src/components/shared/num.tsx`), a single blue accent (`#2f6fed` light /
  `#5a93ff` dark) reserved for interactive actions only (buttons, links,
  active nav — never informational cards), and explicit
  `--success`/`--warning`/`--danger` tokens reserved for budget/payment
  health only. All wired through the *existing* shadcn variable names in
  `src/styles.css`'s `@theme inline` block (this project's Tailwind v4
  CSS-first equivalent of `tailwind.config.js` — there is no such file to
  edit) rather than a parallel set of variables. New "status rail"
  signature element (`src/components/shared/status-rail.tsx`): a 3px,
  never-rounded colored left border on ad account/client/payment rows,
  reusing each page's already-computed Meta-remaining/payment-status data
  (USD-only, same gate as the rest of the Meta integration) — no color
  shown when health is unknown (unlinked account, non-USD, Meta
  unreachable) rather than a false "on-track." Real, working dark mode
  added for the first time: the app already had a `.dark` block and
  `dark:` utility classes throughout that were inert dead code (no toggle
  existed) — switched `@custom-variant dark` from a `.dark` class selector
  to `[data-theme="dark"]`, so every existing `dark:` usage lit up app-wide
  with zero per-component changes. New `src/lib/theme/theme.ts` +
  `<ThemeToggle>` (header, next to the notification bell): persists to
  `localStorage`, defaults to system preference, blocking init `<script>`
  in `__root.tsx` avoids a flash of the wrong theme. Verified live
  (temporary Playwright, same pattern as earlier sessions, removed after):
  login page + dashboard/ad accounts/clients/payments admin pages, both
  themes. Deliberately scoped to exactly what the owner's spec named —
  KPI cards, the three list tables, and the ad account detail page's
  Usage/Meta/Assignment-History surfaces — not swept across every money
  figure in the app (ledger, reports, portal pages, etc. still use plain
  text); `.num`/`railClassName()` are now available for those if wanted
  later.
- **Visual design pass — shared `StatCard`, ledger legibility (post-Phase-8
  addition): done, pending owner review, no migration.** Findings came from
  screenshotting every admin + portal screen in both themes and at 390px,
  not from reading code — all four items below were visible on screen.
  **`src/components/shared/stat-card.tsx` is now the single KPI tile**,
  replacing three drifted inline copies (admin dashboard, portal dashboard,
  `FinancialSummary`). It fixes two things those copies shared: (1) every
  one rendered an empty `<CardContent />`, which still costs the card's
  `gap-6` + `py-6` — about 60px of dead space under each figure, so tiles
  are ~25% shorter now; (2) a label that wrapped to two lines pushed its
  figure down while its neighbours stayed put, so rows read ragged — the
  value is now bottom-anchored (`mt-auto`) and any hint sits **above** the
  number, never between it and the card edge, so figures share a baseline
  regardless of label or hint length. **Keep hints above the value** if
  editing this component; putting them below re-breaks the alignment.
  Portal dashboard grid went 4 columns → 3: with 7–9 tiles (the two Meta
  ones are conditional) a 4-up grid always stranded one card alone on the
  final row. Portal figures also finally got the `.num` tabular treatment —
  until now the same app rendered money in mono on the admin side and
  proportional sans in the portal.
  **Ledger debit vs credit were visually identical** (same weight, same
  colour) on the one screen whose whole job is showing which way money
  moved — credits now render in `--success`, debits in neutral bold, and
  the empty side's em-dash is dimmed so the eye lands on the real figure.
  Still deliberately untouched: reports pages and the remaining plain-text
  money figures outside the screens above.
  **Bug this introduced, found and fixed the same day**: `StatCard` wrapped
  its value in a `<p>`, but the loading `Skeleton` renders a `<div>` —
  invalid HTML, and React logged a hydration error on every dashboard load.
  Typecheck can't catch it; it showed up in the browser console during a
  later verification run. The value element is a `<div>` now.
- **Platform management split into its own `/platform` panel (post-Phase-8
  addition): done, pending owner review, no migration.** Owner's call ahead
  of building more platform-level features — the vendor plane shouldn't
  live inside one agency's admin area. Three areas now: `/platform`
  (vendor), `/admin` (one agency's own data), `/portal` (one client's own
  data). Organizations moved from `/admin/organizations` to
  `/platform/organizations`, with its component to
  `src/components/platform/organizations/`; `/platform` itself redirects
  there until there's a second screen worth a real overview page.
  **`routes/platform/route.tsx`'s guard checks ONLY `isPlatformAdmin`** —
  deliberately not the ADMIN/SUPER_ADMIN role. While the panel sat under
  `/admin` it inherited that route's role check, so a platform admin had to
  also hold an agency role just to reach it (documented as a known catch at
  the time); a platform-only account would have been bounced to `/portal`.
  Splitting the areas removes the coupling rather than papering over it.
  The subscription gate is not applied in `/platform` either — a platform
  admin bypasses it everywhere by design, and this is the screen they'd use
  to fix a subscription.
  Navigation between areas is explicit both ways: `ADMIN_NAV` carries a
  "Platform" item (still behind the `platformAdminOnly` filter in
  `admin/route.tsx`), `PLATFORM_NAV` carries "Back to agency".
  New `showSearch` prop on `AppShell`/`Header`, set false for `/platform`:
  the header's global search covers one agency's own clients and accounts,
  so offering it in a cross-org area searches the wrong scope.
  Verified in-browser for all three user types — platform admin reaches
  the panel; an agency ADMIN hitting `/platform/organizations` lands on
  `/admin` and never sees the nav item; a CLIENT lands on `/portal`.
  `/admin` and `/portal` were otherwise untouched — no other URL changed.
- **"New agency" onboarding (post-Phase-8 addition): done, pending owner
  review, no migration.** Closes the last path that required hand-written
  SQL: adding a customer previously meant creating the auth user in the
  Supabase dashboard, then two UPDATEs. `createOrganizationFn`
  (`organization.fns.ts`, `requirePlatformAdmin`) creates the organization
  **and** its first SUPER_ADMIN login in one call — deliberately together,
  because each half is useless alone: an organization with no login can't
  be reached, and **a new account without an explicit `organization_id`
  and `role_id` lands in org zero as a CLIENT**, since that's what
  `handle_new_user()` defaults to. Those two fields are precisely what the
  manual SQL existed to set; if this fn is ever refactored, they must stay.
  Failure handling, in order: the email is checked via
  `find_auth_user_by_email` **before** the organization row is inserted (a
  duplicate would otherwise leave an empty agency behind), and since
  Postgres and the auth API are not one transaction, anything failing
  after the insert deletes the half-created user and the organization
  rather than orphaning either. The new admin is never
  `is_platform_admin` — they own an agency, not the platform.
  UI: `CreateOrganizationDialog`
  (`src/components/platform/organizations/`), one form in two sections
  (agency, then first admin login), behind a "New agency" button on the
  panel.
  Verified end-to-end against the live project through the real UI, not
  just typecheck: created an agency in the dialog, confirmed in the DB
  that the admin profile pointed at the **new** org with SUPER_ADMIN and
  no platform flag, then signed in as that admin through the real login
  form and landed on an empty `/admin` — no Platform nav item, none of
  xRush's six clients visible, own clients list empty. Test agency + user
  + audit rows deleted afterwards; xRush Agency confirmed the only
  remaining organization.
- **Platform and agency separated into independent entities + agency
  profile page (post-Phase-8 addition): done, pending owner review, no
  migration.** Owner's direction: the platform panel is a separate entity,
  not a section of the agency app, and the two must not cross-link.
  Removed "Back to agency" from `PLATFORM_NAV`, the "Platform" doorway
  from `ADMIN_NAV`, and the `platformAdminOnly` field + filtering in
  `admin/route.tsx` that existed only to serve that doorway.
  **`homePathForUser()` now returns `/platform` for a platform admin**
  before considering role — it previously routed purely by role, so a
  platform-only account would have been dropped into the agency app. Its
  signature widened to `Pick<SessionUser, 'role' | 'isPlatformAdmin'>`;
  covered by a unit test. Nothing else in the agency app changed.
  New **agency profile** at `/platform/organizations/$organizationId`
  (`getOrganizationFn`, `requirePlatformAdmin`): usage counts (clients, ad
  accounts, staff logins, active portal logins), the subscription record,
  and the agency's own admins with emails — the "who do I contact"
  question. Suspend/activate and edit work from here as well as the list.
  Closes the "no usage metrics per organization" gap from the gap audit.
  **Deliberately aggregate-only, and this is a boundary to preserve**: the
  profile exposes counts and admin contacts, never an agency's clients,
  ledger or account rows. A platform admin manages subscriptions; reading
  a customer's books is a separate power that nothing currently grants
  (every other server fn filters on the caller's own organization). The
  page states this in a footnote so the limit is visible rather than
  assumed — if support-style impersonation is ever wanted, it should be
  built explicitly and audited, not by loosening this fn.
  Verified in-browser against live data: real figures for xRush Agency
  (6 clients, 34 ad accounts, 4 staff, 9 portal logins) and all four of
  its admins listed. Zero console errors.
- **Limit requests on platform-assigned accounts route through the agency to
  the platform for approval (post-Phase-8 addition): done, pending owner
  review. Migrations `20260723000038`/`20260723000039` confirmed applied to
  the live project.** Spec §4.3 of "Mother Platform Account Control." Confirmed
  via a clarifying question first — a bare "okay" was ambiguous, and this
  inverts real behavior for all 34 of xRush's live accounts (100% currently
  platform-assigned), so it wasn't assumed from that alone.
  **THE RULE**: an agency can no longer approve a `platform_assigned`
  account's limit request directly — it can only reject it outright, or send
  it to the platform (`sendLimitRequestToPlatformFn`). Gated the exact same
  way as `canMutateSpendCap()`'s direct-edit lock: `ad_accounts.is_platform`,
  not a copy of that flag on the request. `approveLimitRequestFn` now refuses
  outright when the account is platform-assigned. Agency-owned accounts are
  completely unchanged.
  New `limit_requests.status` value `PENDING_PLATFORM_REVIEW` (a standalone
  migration first, since a new enum value can't be used in the same
  transaction that creates it) plus `sent_to_platform_at`/`sent_to_platform_by`.
  The one-pending-per-account unique index now covers both in-flight statuses.
  New `src/server/platform/limit-requests.fns.ts`
  (`listPlatformLimitRequestsFn`/`getPlatformLimitRequestFn`/
  `approvePlatformLimitRequestFn`/`rejectPlatformLimitRequestFn`/
  `rebasePlatformLimitRequestFn`/`getPlatformLimitProofUrlFn`), all
  `requirePlatformAdmin`, scoped across every agency — not by organization,
  since a request can belong to any agency's client.
  **Platform approval calls the SAME `approve_limit_request` RPC** the
  agency's own approval always has — same ledger debit, same prepaid/partial
  auto-payment, same stale-baseline guard — with `p_organization_id` resolved
  from the request's own client/agency (never the platform admin's own org,
  which has no bearing on whose ledger this is). Both `approve_limit_request`
  and `rebase_limit_request` widen their status check to accept
  `PENDING_PLATFORM_REVIEW` as an alternative to `PENDING` — neither RPC
  needs to know about `is_platform` at all, since the TS layer above never
  calls them for the wrong combination.
  **A real build failure, caught before shipping — worth remembering**:
  everything after approval (proof-linking, notifying the client, pushing the
  new cap to Meta) is identical regardless of who approved, factored into
  `finishLimitRequestApproval()`. Leaving that as a plain exported function
  inside `limit-request.fns.ts` broke the client build the moment a SECOND
  `.fns.ts` file (`server/platform/limit-requests.fns.ts`) imported it by
  name: a plain helper touching a `.server.ts` import is only safe to leave
  in a `.fns.ts` file when every call site is confined to that same file's
  `createServerFn().handler()` bodies, which get specially stripped from the
  client bundle. A second file importing it by name means the bundler can no
  longer prove it's dead code, so its body — and the `getSupabaseAdminClient()`
  call inside — survives into the client bundle and the import-protection
  plugin correctly refuses the build. **Same root cause as this file's own
  documented `ReturnType<typeof getSupabaseAdminClient>` gotcha, just
  triggered by a function instead of a type alias — and I wrote this exact
  mistake once more while building this same feature** (a
  `ReturnType<typeof getSupabaseAdminClient>`-typed parameter in the new
  platform file, caught and fixed the same way, before the bundler even
  needed to catch it). Fixed by moving `finishLimitRequestApproval` and
  `proofPathForRequest` into a new plain `limit-request-approval.service.ts`
  — the same shape `audit.service.ts`/`notification.service.ts` already use
  for precisely this reason: shared server-only helpers live in a plain
  service module used only from within handler bodies, never re-exported
  from another `.fns.ts` file.
  UI: the agency's approval page swaps the amount/rate form for a plain
  Reject/Send-to-Platform card on a platform-assigned account's pending
  request, and a read-only "awaiting platform review" card once sent — no
  rebase or approve controls remain agency-side past that point. New
  `/platform/limit-requests` (list, defaults to "Awaiting Review") and
  `/platform/limit-requests/$requestId` (full approve/reject/rebase +  proof
  viewer, mirroring the agency's own screen) with an added Agency column/row
  since requests here span every organization. New `PENDING_PLATFORM_REVIEW`
  `StatusBadge` color (indigo). The client portal needed zero changes — it
  already renders whatever status comes back, and its Cancel button already
  only shows for literal `PENDING`, so a client correctly can't cancel a
  request once it's under platform review.
  **Verified live against the real production database**, temporary
  Playwright + magic-link session, removed after (`package-lock.json`'s only
  diff is the pre-existing `engines` field npm syncs in, unrelated) — against
  a real pending request (`LR-000060`, a prepaid $100 request on `ADA-0018
  "xRush Agency - Azalyn"`, platform-assigned): the agency's approval page
  correctly shows the new Reject/Send-to-Platform card, no amount/rate
  inputs. Platform nav item and pages render correctly, zero console errors.
  **Update, same day: both migrations applied and re-verified.** Initially
  blocked on no `SUPABASE_ACCESS_TOKEN` — confirmed directly rather than
  assumed at the time (`42703: column "sent_to_platform_at" does not exist`
  against the live project), with the underlying query logic separately
  proven correct minus that column in the `ORDER BY`. The owner supplied a
  token; `supabase migration list` reported both migrations already applied,
  which was **not** taken at face value (this project has a documented case
  of that bookkeeping table drifting from the real schema) — verified
  directly instead: `sent_to_platform_at`/`sent_to_platform_by` both
  queryable, `PENDING_PLATFORM_REVIEW` accepted as a real status, and the
  live `LR-000060` unchanged (`status: 'PENDING'`, `sent_to_platform_at:
  null`). Re-ran the browser check against the now-real schema:
  `/platform/limit-requests`'s "Awaiting Review" tab loads cleanly (0
  results), "Not Yet Sent" correctly lists the real `LR-000060` with its
  agency name in the new Agency column. **Deliberately did not actually send
  or approve/reject the real request** as part of verification — that's a
  real decision on a real client's request, left to whoever actually reviews
  it. `npm test` 83/83, typecheck and build clean throughout.
- **Pool account detail page on `/platform/ad-accounts` (post-Phase-8
  addition): done, pending owner review, no migration.** Requested as "shift
  ad account details page, rename and other things and also live data." The
  platform panel had only the flat pool list (row dropdown + on-demand
  dialogs, see the entry directly below) — never a real detail page the way
  the agency side has one at `/agency/ad-accounts/$accountId`. New
  `/platform/ad-accounts/$accountId` mirrors that page's structure (header
  actions, out-of-sync banner, Overview / Assignment History / Usage tabs)
  for a pool account instead.
  Six new `requirePlatformAdmin`-gated fns in `pool.fns.ts` —
  `getPoolAccountFn`, `renamePoolAccountFn`, `updatePoolAccountDetailsFn`,
  `setPoolAccountStatusFn`, `listPoolAccountHistoryFn`,
  `listPoolAccountUsageFn` — literal counterparts of `getAdAccountFn` /
  `renameAdAccountFn` / `updateAdAccountFn` / `setAdAccountStatusFn` /
  `listAssignmentHistoryFn` / `listAdAccountUsageFn`, same split rationale as
  the spend-cap fns in the entry below: `is_platform = true` only, no
  organization check — a platform admin manages the whole pool account
  regardless of who currently holds the grant.
  **The history/usage fns are deliberately NOT organization-scoped either** —
  unlike every agency-side equivalent, they return an account's full history
  across every agency that has ever held it, not just the current holder;
  that's the entire point of a platform-level view of a pool asset. Schemas
  (`adAccountRenameSchema` etc.) are reused as-is from `schemas/ad-account.ts`
  since none of them depend on an organization.
  New `PoolRenameDialog` / `PoolEditDialog`
  (`src/components/platform/ad-accounts/pool-account-dialogs.tsx`) —
  near-duplicates of the agency's `RenameDialog`/`AccountEditDialog` calling
  the new pool fns and invalidating `platform-pool-accounts`/`pool-account`
  instead of `ad-accounts`/`ad-account` (kept separate rather than adding a
  server-fn prop to the agency dialogs, which are also shared with
  Transfer/Assign/Release — actions with no platform equivalent at all). The
  already-shipped `PoolSpendCapDialog` (entry below) is reused as-is here for
  "Edit spend cap" rather than building a third variant of that dialog.
  The persistent "Meta live data" card is new — same fields and low-balance
  red styling as the agency page's card, auto-fetched via the existing
  `fetchPoolAccountMetaFn`. Before this, live Meta data for a pool account was
  only reachable by opening `PoolSpendCapDialog`. Grant/Revoke moved onto this
  page's header dropdown too (reusing `grantPoolAccountFn`/
  `RevokeGrantDialog`), giving the detail page full parity with the list
  row's actions plus Rename/Edit/Activate-Deactivate/tabs the list never had.
  `RevokeGrantDialog` gained one more query invalidation
  (`['pool-account', id]`, harmless on the list page where that key doesn't
  exist) so a revoke from the detail page updates "Assigned agency"
  immediately rather than only after a full reload.
  **Verified live** against the real production database (temporary
  Playwright + magic-link session, removed after — the only lockfile diff
  left behind was npm filling in the pre-existing `engines` field from
  `package.json` into `package-lock.json`'s root metadata, unrelated to
  Playwright): opened a real linked account (`ADA-0003 "DF IT Random 01"`)
  and got genuine live Meta data ($4,450.00 cap / $4,359.57 spent) on both the
  persistent card and the "Edit spend cap" dialog opened from it; confirmed
  "Assigned agency" links to xRush Agency; confirmed the header dropdown shows
  Rename/Edit details/Deactivate/Revoke; opened Rename and confirmed it
  prefilled the real account name, then cancelled with nothing saved;
  confirmed the tabs show real counts. Confirmed the negative case too:
  xRush's own agency admin hitting the new URL directly still redirects to
  `/agency`. Zero console errors. `npm test` 83/83, typecheck and build clean.
- **Platform-side Meta spend-cap controls added — closes the "known gap"
  from the entry directly below (post-Phase-8 addition): done, pending owner
  review, no migration.** Requested as "shift editing options in the platform
  manager." Without this, the 3 actions just locked to `isPlatformAdmin` had
  nowhere to be performed at all.
  New `updatePoolAccountSpendCapFn` / `applyPoolAccountSpendCapFn` /
  `retryPoolAccountSpendCapSyncFn` / `fetchPoolAccountMetaFn`
  (`src/server/platform/pool.fns.ts`), all `requirePlatformAdmin`.
  **Deliberately NOT scoped by grant, unlike every agency-side ad-account fn**:
  these check only `is_platform = true`, nothing else — a platform admin
  manages the WHOLE pool regardless of who currently holds a grant, since
  granting only ever changed who may USE an account, never who owns its Meta
  connection. Kept as literal near-duplicates of the agency-side handlers
  (`updateMetaSpendCapFn` etc. in `meta.fns.ts`) rather than one shared
  helper parameterized on "how do I load the account" — the one line that
  differs (an organization check vs. none) is exactly the point of the split,
  and folding it into a shared helper would have obscured that rather than
  expressed it.
  Audit rows land in whichever agency currently holds the grant
  (`operatingOrganizationId()`, same helper the cron already used for this) —
  same transparency principle as the platform's "View agency data" screen:
  the holder sees a platform-made change in ITS OWN audit log, falling back
  to the platform's own organization while a pool account is ungranted.
  UI: new `PoolSpendCapDialog`
  (`src/components/platform/ad-accounts/pool-spend-cap-dialog.tsx`) —
  combines the agency side's two separate dialogs (fetch+apply, edit) into
  one, since a pool account has no detail page with tabs to spread them
  across. Wired into `/platform/ad-accounts`'s row dropdown as "Meta spend
  cap", plus a conditional "Retry sync" item and a `TriangleAlert` next to
  Current limit when `meta_sync_pending`.
  **Verified live, including the otherwise-untestable path**: opened the
  dialog on a real granted account (`ADA-0001`) and got real Meta data
  ($11,100.00 cap / $11,070.40 spent — same account used to verify the lock
  itself in the entry below, so both sides of this feature were checked
  against the same real data). Since 0 of the 34 live accounts are
  `meta_sync_pending` today, temporarily flagged that same account to
  exercise "Retry sync" for real — the warning icon rendered, the retry
  correctly resolved it against live Meta data with no Meta write (already in
  sync), and the account was confirmed back to its exact original state
  (`meta_sync_pending: false`, `meta_sync_error: null`,
  `current_limit_usd: 11100`) immediately after. Confirmed the negative case
  too: xRush's own agency admin still redirects to `/agency` when hitting
  `/platform/ad-accounts` directly. `npm test` 83/83.
- **Manual Meta spend-cap actions restricted to the platform, on
  platform-assigned accounts only (post-Phase-8 addition): done, pending
  owner review, no migration.** First slice of a larger "Mother Platform
  Account Control" spec. Checked every table the spec proposed against the
  live schema BEFORE writing anything — all 11 were missing (`agencies`,
  `platform_admins`, `platform_ad_account_pool`, `client_funding_payments`,
  `subscription_plans`, etc.), because the concepts already exist under this
  codebase's own names (`organizations`, `is_platform_admin`,
  `ad_accounts.is_platform` + `platform_account_grants`, `payments` +
  `ledger_entries`). Nothing here is a rename of that existing machinery —
  it's the one genuinely new rule the spec asked for.
  **THE SCOPE DECISION, confirmed explicitly via AskUserQuestion before
  writing code — do not widen this to "every mutation" without asking
  again**: locking ALL writes on a `is_platform` account (the spec's literal
  §3 pseudocode) would have stopped xRush editing any of its own 34 accounts
  the day this shipped, since 100% of them are currently platform-assigned
  (the whole fleet moved into the pool and was granted back — see the pool
  migration entry above). So the lock is narrow: only the 3 actions that
  reach or pull from the account's OWN Meta connection —
  `updateMetaSpendCapFn` (push), `applyMetaSpendCapFn` (pull), and
  `retryMetaSpendCapSyncFn` — require `isPlatformAdmin`. Rename, status
  change, assign/release/transfer, limit-request approval, and viewing live
  Meta data (Remaining, Meta Due) are UNCHANGED for every account an agency
  holds, owned or granted.
  New `canMutateSpendCap(account, actor)`
  (`src/lib/meta/credential-scope.ts`, 6 unit tests):
  `!account.is_platform || actor.isPlatformAdmin`. Applied at
  `loadUsdLinkedAccount` (the one shared loader behind
  `updateMetaSpendCapFn`/`applyMetaSpendCapFn`) and separately in
  `retryMetaSpendCapSyncFn`.
  **THE ONE THING THAT MUST STAY UNGATED — do not "fix" this later**:
  `syncAndPersistAdAccountSpendCap`, called from inside
  `approve_limit_request` with no actor, is NOT gated by this check (verified
  zero diff on `spend-cap-sync.server.ts` and `limit-request.fns.ts`). That
  sync is the automatic side effect of an agency approving its OWN client's
  limit request — a flow that stays fully agency-controlled regardless of
  who owns the account. Gating it too would silently stall every limit
  approval on a platform-assigned account, breaking the common path to lock
  down a rare manual one.
  UI: `$accountId.tsx` computes `spendCapMutable = canMutateSpendCap(account,
  user)` once and threads it to all three surfaces — the "Edit spend cap"
  button and the out-of-sync "Retry sync" banner both swap to a "Managed by
  the platform" note when locked; `MetaFetchDialog` gained a
  `canApplySpendCap` prop (default `true`) that does the same to "Apply as
  current limit" while leaving the read-only fetch itself untouched.
  **Known gap, flagged not built**: nothing on `/platform` currently exposes
  these 3 actions to a platform admin, so a `meta_sync_pending` account on
  the platform side is unreachable by anyone until such a screen exists.
  Real but rare — 0 of the 34 live accounts are in that state today, and the
  common path (auto-sync after approval) is unaffected. A natural, small
  follow-up on `/platform/ad-accounts` if wanted.
  Verified live against a real granted account (`ADA-0001`, held by xRush):
  "Edit spend cap" hidden with the note; "Fetch from Meta" still returns real
  Meta data (spend $11,068.21 / cap $11,100.00, proving the read path is
  untouched) but "Apply as current limit" is replaced with the note; the
  actions menu still shows Rename/Edit details/Fetch from Meta/Deactivate/
  Release exactly as before. `npm test` 83/83.
  **Explicitly NOT started, and it's real work, not a rename**: the spec's
  §4 client→agency→platform account-REQUEST escalation (confirmed no
  "request access to an unassigned account" flow exists — the only requestable
  thing today, `listMyRequestableAccountsFn`, is a limit INCREASE on an
  account the client already holds) and §5/§6's funding + subscription
  ledgers (no `agency_platform_payments`/`ad_account_funding_transactions`/
  real `subscription_plans` — today's subscription model is
  `organizations.subscription_status` + a free-text `plan` string). The
  spec's own §8 open questions (mid-flight reclaim, money-column units,
  partial-payment UI) are unresolved and need answers before that work
  starts — flagged to the owner, not guessed at.
- **"New account" removed from the agency ad accounts page (post-Phase-8
  addition): done, pending owner review, no migration.** Owner: the option is
  not needed. An agency gets ad accounts by grant from the platform pool or via
  "Import from Meta"; manual creation was the redundant third path. Removed the
  header button, its state, and `AccountCreateDialog` (267 lines) from
  `account-dialogs.tsx`.
  **`AccountEditDialog` / `AccountRenameDialog` / `TransferDialog` share that
  file** — that was the real risk, so it was checked in a browser rather than
  assumed: on a real account the actions menu still offers Rename / Edit details
  / Fetch from Meta / Deactivate / Release, and Edit details opens **correctly
  prefilled**. Nothing saved, zero console errors.
  `createAdAccountFn` + `adAccountCreateSchema` are deliberately KEPT though
  nothing calls them — the restore path if the button is ever wanted back, still
  behind `requireAdmin(AD_ACCOUNTS_MANAGE)`. Delete them only if asked.
- **Employees feature REMOVED from the agency app (post-Phase-8 addition):
  done, pending owner review, no migration.** Owner: "i dont need the feature
  right now." Deleted `/agency/employees`, the client detail page's Employees
  tab, `src/components/admin/employee/*`, `src/server/employees/`,
  `src/schemas/employee.ts`, the Employee domain types, the nav item, and the
  `employees.view`/`employees.manage` permission constants.
  **THE TABLES `employees` AND `client_employees` STILL EXIST — do not drop
  them as cleanup.** "Right now" reads as reversible, and dropping them is a
  one-way schema change that would additionally break the live
  `reset_all_data()` RPC (it truncates both) and force edits to `WIPE_ORDER`
  and `OFFBOARD_ORDER`. Both tables are empty, so nothing is preserved but the
  option to restore the feature. The `permissions` rows survive too, with **0
  role grants and 0 user grants** pointing at them — inert.
  `WIPE_ORDER` (`maintenance.fns.ts`), `OFFBOARD_ORDER` (`organization.fns.ts`)
  and `offboarding.test.ts` still list both tables, correctly: the FK to
  `organizations` remains, so removing them from the delete order would strand
  rows and break agency offboarding. Both lists now carry a comment saying so.
  **`Team Members` is a DIFFERENT feature and was NOT touched** — a client's own
  portal logins via `client_memberships`, in `/client/team`. The two only ever
  shared the colloquial word "employee"; keeping them apart is why the removal
  was this clean. See `team.fns.ts`.
  Verified in a browser as a real agency SUPER_ADMIN: 13 sidebar items with no
  Employees, `/agency/employees` 404s, a real client detail page renders with 6
  tabs and no Employees tab, `/agency/users` no longer offers the employee
  permission toggles. `npm test` 80/80.
- **Platform account's user menu no longer says "Role: CLIENT"
  (post-Phase-8 addition): done, pending owner review, no migration.**
  The header printed `user.role` raw, so the platform owner saw
  *"Rush Platform / rush@xrush.online / Role: CLIENT"* and read it as a bug.
  **The data is correct and must stay as it is** — see "Platform and agency
  split into two real accounts" below, which explains why the CLIENT role is
  deliberate. Confirmed live again here: `role=CLIENT`,
  `is_platform_admin=true`, **0 client memberships**, so the role grants the
  account nothing; it is the *absence* of an agency role, and it is what makes
  `/agency`'s `isAdminRole()` check close the agency app to it.
  **THE TRAP THIS DISPLAY SET**: the natural reaction to "Role: CLIENT" is to
  promote the account to SUPER_ADMIN — which would make it a super admin OF
  ORGANIZATION ZERO and hand it xRush Agency's clients and ledger, undoing the
  whole platform/agency split. The label was fixed instead of the column.
  New pure `displayRoleFor(user)` (`src/lib/auth/types.ts`, beside
  `homePathForUser`, 3 unit tests): returns **"Platform Owner"** whenever
  `isPlatformAdmin` — including a dual-hat account, since platform is the wider
  power — and the agency role for everyone else. Used by `header.tsx`.
  Verified in a browser across all three: platform → "Platform Owner", agency
  SUPER_ADMIN → "SUPER ADMIN", client → "CLIENT". `npm test` 80/80.
- **URL scheme renamed — `/admin` → `/agency`, `/portal` → `/client`
  (post-Phase-8 addition): done, pending owner review, no migration.**
  **THE CURRENT URLS ARE `/platform`, `/agency`, `/client`.** Every log entry
  in this file dated before 2026-09-15 names `/admin` and `/portal`; those were
  left as written (they are a historical record, same reasoning as layering
  corrective migrations rather than rewriting past ones). Translate as you read
  them. The routing-convention bullet under "Framework conventions" was updated
  and is the one to trust.
  `src/routes/admin/` → `src/routes/agency/`, `src/routes/portal/` →
  `src/routes/client/` (git mv, so file history follows), then 50 `/admin` and
  19 `/portal` quoted route paths rewritten across 21 files.
  **The rewrite was safe to automate for one specific reason, worth knowing
  before attempting anything similar**: it matched only a path at the START of a
  quoted string (`'/admin`, `"/admin`, backtick-`/admin`), and every import
  specifier in this codebase begins `@/` — verified zero overlap BEFORE running
  it, so `@/components/admin/**` and `@/server/admin/**` could not be hit. A
  bare `/admin` → `/agency` replace would have destroyed those imports.
  **Component directories were deliberately NOT renamed** (`src/components/admin/`,
  `src/components/portal/`, `src/server/admin/`, `src/server/auth/portal-session.fns.ts`)
  — they are not URLs, and this was a URL change. Rename them only if asked.
  **Nothing outside the router referenced these paths** — confirmed before
  starting: no URL path is stored in the database and no server fn builds one
  (notifications carry `entity_type`/`entity_id`, never a link), so there was no
  data migration and no stale link left in a row.
  Route guards and `homePathForUser()` (`src/lib/auth/types.ts`) follow
  automatically. **TanStack Router's typed `to` is the real safety net here**: after
  regenerating the route tree, any missed path is a compile error rather than a
  runtime 404 — so `npm run typecheck` passing is meaningful evidence for this
  particular change, unlike most.
  **Verified in a real browser for all three roles** (temporary Playwright +
  magic-link, removed after, zero lockfile diff): a platform admin lands on
  `/platform/organizations` and is bounced there from `/agency` and `/client`;
  an agency SUPER_ADMIN lands on `/agency` and is bounced there from `/client`
  and `/platform`; a client lands on `/client` and is bounced there from
  `/agency` and `/platform`. All **26 sidebar links across the three areas**
  resolve under their own prefix. `npm test` 77/77.
  **The old URLs 404 rather than redirecting** — the honest result of a rename,
  and acceptable while production isn't in real use. Legacy `/admin/*` →
  `/agency/*` redirect routes are a small separate addition if bookmarks or an
  external link ever need to survive.
- **Meta integration transferred from xRush Agency to the PLATFORM
  (post-Phase-8 addition): done, pending owner review. Migration
  `20260723000037` confirmed applied to the live project.**
  **THE RULE THIS ESTABLISHES — the `META_*` env vars are the PLATFORM's
  credentials, not org zero's. Do not reintroduce an org-zero fallback.**
  The entry below ("Meta integration is now per-organization") says they are
  org zero's own; that is superseded. Every one of the 34 accounts they govern
  is a platform-pool account (`is_platform`, `organization_id` NULL), so the
  portfolio always belonged to the platform — org zero merely had the only
  screen that could edit it.
  New `platform_settings` table: key/value, **no `organization_id` column at
  all**, RLS enabled with zero policies (same treatment as `app_settings`,
  which holds the same class of secret). Deliberately a separate table rather
  than a reserved id inside `app_settings`: that column is NOT NULL and
  FK-constrained, so the platform would have needed a fake `organizations`
  row — reintroducing exactly the agency/platform conflation this undoes.
  `metaCredentialOrgFor()` → **`metaCredentialScopeFor()`**, returning
  `{ kind: 'platform' } | { kind: 'organization', organizationId }` instead of
  a bare id (`src/lib/meta/credential-scope.ts`). `getMetaConfig()`,
  `isMetaConfigured()`, `fetchMetaAdAccount()`, `listMetaBusinessAdAccounts()`
  and `updateMetaAdAccountSpendCap()` all take that scope. A union rather than
  two id-shaped values on purpose: a platform scope carries no organization id,
  so there is no id for a future edit to accidentally resolve against
  `app_settings`.
  **`/platform/settings`** (new, in `PLATFORM_NAV`) manages the platform's
  credentials; `/admin/settings` still manages each agency's own, unchanged.
  The card moved to `src/components/shared/integration-settings/` and takes a
  `scope` prop — one component, because both screens share the masking,
  never-prefill and clear-vs-remove rules and a second copy would drift (see
  `StatCard`, and `WIPE_ORDER` before it). The platform screen is gated only by
  `/platform`'s `isPlatformAdmin`; the agency one keeps
  `integrations.manage`, because an agency has admins of varying power while a
  platform admin is already the most privileged account there is.
  **TWO SILENT REGRESSIONS THIS WOULD HAVE CAUSED — both found by reasoning
  about what reads these credentials, not by anything failing:**
  1. **Every live Meta figure for xRush would have gone blank.** The ad accounts
     list, the clients list and the client detail page read live data through
     `listMetaBusinessAdAccountsFn`, which lists *the agency's own portfolio* —
     and xRush no longer has one. That only ever worked because org zero's
     credentials and the platform's were the same object. New
     **`listUsableMetaAdAccountsFn`** fetches across every credential set the
     agency can actually reach (own portfolio + the platform's, for granted
     accounts), deduped via `credentialScopeKey()` to one Graph call per
     portfolio, and returns only accounts linked here — an agency has no
     business seeing the platform's unimported inventory. The import dialog
     keeps the original fn: "your own portfolio" is the correct scope for
     importing, and pool accounts arrive by grant, never by import.
  2. **Telegram alerts for the whole pool would have stopped.** `alertTelegram()`
     gated on `organizationId !== DEPLOYMENT_ORGANIZATION_ID`, and the pool used
     to be synced under org zero's id — it passed the gate by accident. Now
     fires for the platform scope OR org zero, documented in place.
  `syncCredentialSet()` takes the scope alone and derives `platformPool` from
  it, so a portfolio and a row set that don't belong together can no longer be
  passed. The cron's result rows report `organization_id: null` for the pool —
  it is a credential set, not an agency.
  **Also added, because the transfer would otherwise have REMOVED a working
  capability**: "Add from Meta" on `/platform/ad-accounts`
  (`listPoolImportCandidatesFn` / `importPoolAccountsFn`,
  `requirePlatformAdmin`). No agency can see the platform's portfolio any more
  and the pool panel had no import screen, so adding a newly-created Meta
  account to the pool would have required hand-written SQL. Imported rows are
  `is_platform: true`, `organization_id: null`, ungranted, `usd_rate: 0`
  (inherit — a pool account has no client until it is granted AND assigned, so
  there is nothing to bill yet, unlike the agency import which asks for a rate).
  Candidates are checked against EVERY `ad_accounts` row, not just pool ones,
  since `external_account_id` is globally unique. Audited as
  `AD_ACCOUNT_CREATED` / `metadata.source: 'PLATFORM_POOL_IMPORT'`.
  **Verified live, not just typechecked**: `platform_settings` created and empty
  (so the env fallback is what is running); the platform scope resolves and
  reaches the portfolio (36 accounts); **both xRush Agency and Arrow Solutions
  now resolve to "not configured"** — neither borrows the platform's token.
  Write/read/clear round-tripped through the new table using `META_API_VERSION`
  only — never the token, and written to the same value as env, so a failure
  mid-test would have changed nothing. RLS proven *with a row present* (an empty
  table would have made the anon read look blocked either way): service role
  sees 1, the public anon key sees 0, and an anon write is refused with 42501.
  In a real browser (temporary Playwright + magic-link, removed after, zero
  lockfile diff): `/platform/settings` shows all three fields as "Environment
  variable"; **xRush's own Settings now shows the token and Portfolio ID as "Not
  set"** while API version still shows env (deliberate — a protocol version, not
  a credential); `/admin/ad-accounts` still shows **Remaining and Meta Due on
  34/34 rows**, which is the regression check that matters; the pool import
  dialog lists exactly the 2 portfolio accounts not yet pooled and disables
  submit with nothing selected. Nothing was imported. Zero console errors.
  `npm test` 77/77.
- **SECURITY FIX — pool accounts bypassed the assignment RPCs' IDOR guard
  (post-Phase-8 addition): migration `20260723000036`, confirmed applied to the
  live project.** Found by auditing for data missed after the pool migration
  set `ad_accounts.organization_id` to NULL on every pool account.
  **The bug, and the trap to remember**: `assign_ad_account`,
  `release_ad_account` and `transfer_ad_account` validated ownership with
  `if v_account.organization_id <> p_organization_id then raise ...`. That was
  correct while every account belonged to an agency. For a pool account the
  column is NULL, and **`NULL <> anything` is NULL, not true** — which
  PL/pgSQL's `IF` treats as false — so the guard silently never fired. Any
  organization could assign, release or transfer any pool account, including
  one granted to a different agency. **Never compare a nullable
  organization_id with `<>`/`=` and expect a guard to hold.**
  Proven empirically BEFORE fixing (two throwaway agencies): B assigned a pool
  account granted only to A to one of B's own clients and it SUCCEEDED, while
  the same attempt on an account A owned was correctly REFUSED. After the fix
  the attack is refused with no assignment row created, and the legitimate
  holder can still assign AND release both owned and granted accounts (checked
  explicitly — the obvious way to "fix" this is to over-restrict and lock the
  real holder out).
  New `org_can_use_ad_account(p_account_id, p_organization_id)` — owned-by-them
  OR granted-to-them, the same union as `scope.server.ts`, NULL-safe because
  `EXISTS` returns a real boolean. `service_role` execute only. The three
  functions are otherwise byte-identical to `20260723000032`; only the check
  changed (bodies were extracted programmatically rather than retyped).
  Both directions are locked by regression tests in `pool-isolation.test.ts`
  (now 10 tests).
- **Two more pool-migration follow-ups fixed in the same audit.**
  `getOrganizationFn` reported **"Ad accounts 0"** for an agency holding 34
  granted accounts (plain `organization_id` count → now the union).
  **Revoking a grant had no confirmation**, unlike every other destructive
  action in this app — a single dropdown click instantly took a live account
  from an agency, and did so twice during this session's own browser testing,
  stripping `ADA-0006` from xRush both times (restored, 34/34 confirmed). Now
  goes through `RevokeGrantDialog`, which states that the agency loses it
  immediately and its clients holding it lose it too.
  **Data integrity confirmed intact** across all 17 tables: no dangling
  `organization_id`, no financial rows orphaned from a client, no ownership
  CHECK violations, all 18 active assignments consistent with the agency
  actually holding the account, and every screen reconciles with the database.
  Nothing was lost by the migrations.
- **Platform support view onto an agency's real data (post-Phase-8 addition):
  done, pending owner review, no migration.**
  **The finding that prompted it**: the platform account could already read
  every agency's rows, because migration `20260723000031` ends 17 RLS SELECT
  policies with `or public.is_platform_admin()`. Proven empirically with the
  **public anon key** and a real platform session (i.e. browser-reachable, not
  service-role): 7 clients including one from a separate seeded agency, 84
  ledger entries, 33 payments, 34 ad accounts, and the other agency's ledger
  rows verbatim. The app layer hid this (`/admin` redirects a platform account,
  the profile is aggregate-only) — so the power existed and nothing recorded
  its use. Owner chose to keep the capability and surface it properly rather
  than close the bypass.
  `getAgencySupportDataFn` + `/platform/organizations/$organizationId/data`:
  the agency's real clients (with ledger-derived dues via
  `all_client_dues`), its ad accounts through the owned-or-granted union, and
  its 100 most recent ledger entries. Reached by an explicit "View agency data"
  action, never inline on the profile.
  **THE AUDIT ROW GOES IN THE VIEWED AGENCY'S ORGANIZATION, NOT THE
  PLATFORM'S — do not "fix" this to actor.organizationId.** That is the whole
  transparency property: the customer sees when the vendor opened their books,
  in their own Audit Log, next to their staff's actions. It works because
  `listAuditLogsFn`'s actor-name lookup is NOT org-scoped, so the platform
  admin's name resolves there. Verified: xRush's own audit log shows
  *"Rush Platform — Platform Agency Data Viewed"*. Written BEFORE the data is
  returned so a half-rendered page still counts as an access, and the page uses
  `staleTime: Infinity` / no refetch-on-focus so background refetching cannot
  inflate the log with accesses nobody made.
  **Read-only by design** — nothing here writes to an agency's data. Viewing a
  customer's ledger is support; editing it is a different power needing its own
  deliberate design.
  The agency profile's footnote previously claimed an agency's data "stays
  private to them", which was true of the UI and false of the database; it now
  states the records are one click away and that opening them is logged.
  **Two bugs caught by screenshotting rather than reading code**:
  1. **The new route silently didn't exist.** `$organizationId.data.tsx`
     alongside a leaf `$organizationId.tsx` makes the latter a LAYOUT parent;
     with no `<Outlet />` the child never renders and `/data` showed the
     profile page with no error at all. Fix: rename the leaf to
     `$organizationId.index.tsx` so they are siblings. Remember this whenever
     adding a child route next to an existing flat leaf.
  2. **`getOrganizationFn` reported "Ad accounts 0"** for an agency holding 34
     granted accounts — its count still used a plain `organization_id` filter,
     which the pool migration set to NULL. Now uses the same owned-or-granted
     union as every other ad-account read.
  **Incident from this session's own verification, for the record**: a browser
  test run as the platform account revoked the grant on `ADA-0006`
  ("xRush Agency - Skinthic 02"), leaving xRush with 33 of its 34 accounts.
  Caught by asserting `pool count == grant count` afterwards, restored, and the
  stray `PLATFORM_ACCOUNT_REVOKED` audit row removed since it recorded a test
  artifact rather than a real decision. Lesson: these verification scripts drive
  the REAL production database through a UI that now has destructive actions on
  it — assert invariants after every run, and prefer throwaway organizations
  over the owner's own.
- **Platform and agency split into two real accounts (post-Phase-8 addition):
  done, pending owner review, no migration.** Completes the separation the
  owner asked for when `/platform` was carved out — it had been blocked only on
  the new account's email.
  **`rush@xrush.online` is the platform account**: organization zero (every
  profile needs one, `organization_id` is NOT NULL, and org zero *is* the
  deployment's own organization — see `DEPLOYMENT_ORGANIZATION_ID`), the signup
  trigger's default **CLIENT** role, `is_platform_admin = true`.
  **`mehedi.h.prantoz@gmail.com` is now xRush Agency's owner only** —
  SUPER_ADMIN of org zero, `is_platform_admin = false`.
  **THE CLIENT ROLE IS DELIBERATE — do not "correct" it to SUPER_ADMIN.**
  `requirePlatformAdmin()` checks only `isPlatformAdmin`, never the role, so the
  platform account needs no agency role at all; giving it an admin role would
  hand it xRush's clients and ledger, which is precisely what this split
  removes. Its practical effect is that `/admin`'s `isAdminRole()` check closes
  the agency app to it.
  **Executed in the safe order**, old account never interrupted: create the new
  account → prove it signs in **through the real login form with the real
  password** (not magic-link injection) and reaches `/platform` → only then
  clear the flag on the original. The clearing step refused to run unless the
  new account was already a platform admin, so the platform could never be left
  with zero admins.
  **Dead end closed in the same pass**: a platform-only account holds no agency
  role, so `/admin`'s role check bounced it to `/portal`, where it has no client
  membership and every portal query would fail. `portal/route.tsx` now redirects
  `isPlatformAdmin` users to `/platform`. Deliberately NOT added to
  `admin/route.tsx`: sending every platform admin away from `/admin` would lock
  a dual-hat account out of its own agency mid-migration — a hazard, not a rule.
  **Verified both directions in a real browser.** New account: real-password
  login → `/platform/organizations`, both agencies and all 34 pool accounts
  visible, `/admin` → redirected with no agency data rendered. Old account:
  → `/admin`, dashboard and all 34 ad accounts intact, no platform nav,
  `/platform/organizations` → `/admin` with no sight of Arrow Solutions. Zero
  console errors either side. `npm test`: 72/72.
  **Failure mode worth knowing**: if `is_platform_admin` is ever cleared on
  `rush@xrush.online` it becomes a CLIENT-role account with no memberships and
  effectively has nowhere to go. That is acceptable for a break-glass account,
  but it means the flag should be flipped back rather than the role changed.
- **Agency offboarding + the permissions test unstuck (post-Phase-8 addition):
  done, pending owner review, no migration.**
  `deleteOrganizationFn` (`requirePlatformAdmin`) permanently removes an agency
  and everything belonging to it, wired to a "Delete agency" action on the
  agency profile. Four guards, all deliberate: never the caller's own
  organization; never `DEPLOYMENT_ORGANIZATION_ID` (org zero owns the platform
  pool's credentials and every platform login); the subscription must already
  be `cancelled`, making deletion a considered second step rather than one
  click from a paying customer; and the caller must retype the agency's exact
  name — **not** a fixed phrase like "Clear all data" uses, because every
  agency's screen is identical and a fixed phrase is easy to type confidently
  on the wrong one.
  **The reason an ordered teardown is needed at all**: all 17 multi-tenant
  tables reference `organizations(id)` with **no ON DELETE clause**, so the
  organization row cannot be deleted until its data is. `OFFBOARD_ORDER` (in
  `organization.fns.ts`) satisfies those keys and is deliberately a SUPERSET of
  `maintenance.fns.ts`'s `WIPE_ORDER` — that one clears business data but keeps
  the agency operating (admin logins, rates, finance records survive), whereas
  this removes the agency entirely and so also takes `exchange_rates`,
  `usd_margin_entries` and finally `user_profiles`. Auth users are deleted
  last: every FK to `auth.users` is NO ACTION, so they only become deletable
  once the rows naming them are gone. The audit row is written FIRST and lands
  in the acting platform admin's own organization, so the record of the
  offboarding survives the agency it describes.
  **Platform-pool accounts survive offboarding, by construction**: their
  `organization_id` is NULL so the `ad_accounts` delete never matches them, and
  their grant disappears via `platform_account_grants`' ON DELETE CASCADE —
  the account returns to the pool unassigned. A departing customer must never
  destroy an account the platform owns and merely lent them.
  `cancelled` is now settable from the UI (profile page overflow menu) — an end
  state distinct from Suspend's temporary lock-out, and the prerequisite for
  deletion. Kept off the list page on purpose: terminal actions belong where
  the counts of what will be destroyed are on screen.
  **Also fixed: the long-standing failing test.** `permissions.test.ts`
  asserted exactly four sensitive permissions; `finance.view`/`finance.manage`
  were added in commit `0e3e8fe` and the expectation was never updated (flagged
  as pre-existing in every pass since the multi-tenant work). It remains an
  exact allow-list deliberately — marking a permission sensitive restricts it
  to SUPER_ADMIN by default and un-marking one quietly widens access, so a new
  sensitive permission SHOULD fail this test until listed on purpose. The count
  is out of the title, which is what let it go stale.
  **Verified**: new gated integration test `offboarding.test.ts` (6 tests)
  against the live project — the organization cannot be deleted while its data
  references it, `OFFBOARD_ORDER` then satisfies every FK, the agency's own ad
  account is deleted while the granted pool account survives with
  `is_platform: true` / `organization_id: null` and no grant, and nothing is
  left behind. The full flow was also driven through the real UI: Delete
  blocked while Active (warning shown, name field hidden, button disabled),
  blocked again on a mismatched name, then a real deletion that removed the
  agency and redirected to the list. Throwaway agency cleaned up; zero console
  errors. **`npm test`: 72/72 — the first fully green run in this project.**
- **Platform-owned ad account pool + grants (post-Phase-8 addition): done,
  pending owner review. Migration `20260723000035` confirmed applied to the
  live project** (via `supabase db push`; verified directly afterwards — 34/34
  ad accounts now `is_platform = true` with `organization_id` NULL, 34 grants
  all pointing at org zero, and the mutual-exclusivity CHECK confirmed to
  reject a platform+organization row). A second ownership model for ad
  accounts: the PLATFORM (the vendor layer behind `/platform`, not a customer)
  owns a central pool and grants individual accounts to agencies. An agency's
  accounts are now the UNION of what it connected itself and what it has been
  granted. The agency-connects-its-own-Meta-credentials flow is untouched.
  **TWO NAMING TRAPS, both deliberate — do not "tidy" either**:
  1. `ad_account_assignments` = ad account -> **CLIENT** (Phase 2, the
     assign/release/transfer feature with its own RPCs, history UI and ledger
     interaction). The new table is `platform_account_grants` = ad account ->
     **AGENCY**. The request asked for a table literally named
     `ad_account_assignments`; that name was already taken by a live feature
     with 18 ACTIVE rows, so it was flagged and the owner chose a distinct
     verb ("grant" vs "assign") so the two can never be confused in code,
     conversation or the audit trail. Same discipline as Remaining vs Current
     balance and Employees vs Team Members.
  2. There is **no Meta credentials table with rows to re-tag**. Credentials
     live in `app_settings`, a key/value table keyed `(organization_id, key)`
     — three rows per agency, not one row per credential — and xRush had
     **zero** rows there (its credentials are the `META_*` env vars). So
     `is_platform` on "the credentials table" was not buildable as specified
     (`organization_id` is half that table's PK and cannot be NULL). The owner
     chose instead to reclassify the env vars as **the platform pool's
     credential**, which is what they already were in everything but name.
  Schema: `ad_accounts.is_platform boolean not null default false`;
  `organization_id` made nullable; `ad_accounts_ownership_ck` enforces mutual
  exclusivity (platform => org NULL, agency => org NOT NULL). New
  `platform_account_grants` (`ad_account_id` **UNIQUE** — one agency at a time
  per account, enforced by the database, not application code —
  `organization_id`, `granted_at`, `granted_by`). SELECT-only RLS following
  the existing convention. `ad_accounts_select` was also widened: it gated on
  `organization_id = current_org_id()`, which is NULL for every pool account,
  so without the extra arm an agency would have lost RLS visibility of its own
  granted accounts.
  **All 34 of xRush's accounts were re-tagged into the pool and granted
  straight back to org zero in the same migration**, so nothing changed for
  its day-to-day work. Confirmed with the owner before writing it — a one-way
  re-tag, not guessed at.
  **The union is defined in exactly one place**:
  `src/server/ad-accounts/scope.server.ts` (`adAccountScope()` /
  `applyAdAccountScope()` / `loadAccessibleAdAccount()` /
  `operatingOrganizationId()`). The multi-tenant pass had spread
  `.eq('organization_id', …)` across ~10 server files by hand; a union
  repeated that many times would drift, so every ad-account read/write now
  routes through the helper — list, detail, update, rename, status, dashboard
  counts, assignable accounts, global search, the account usage report, and
  the Meta fns. `applyAdAccountScope` is **synchronous on purpose**: a
  PostgREST builder is thenable, so an async applier gets awaited by its
  caller and executes the query before `.order()`/`.in()` can be chained.
  **Authorize-then-act replaces the double-`.eq()` pattern**: a granted
  account's `organization_id` is NULL, so `.eq('id', x).eq('organization_id',
  me)` silently matches nothing. Mutations now call
  `loadAccessibleAdAccount()` (which returns "Ad account not found" for both
  missing and not-yours, so existence stays non-probeable) and then act by id.
  **Meta credentials resolve PER ACCOUNT, never per "the current org"**
  (`metaCredentialOrgFor()`, `src/lib/meta/credential-scope.ts`): a pool
  account lives in the platform's Business Portfolio, so an agency's own token
  simply cannot read or write it. Applied in `loadUsdLinkedAccount()`, the
  spend-cap push, `syncAdAccountSpendCap()`, and the portal's
  `listMyAccountsMetaRemainingFn` — which now groups a client's accounts by
  credential set, since one client can hold accounts from both portfolios
  (still one bulk fetch per set, never one per account).
  **The cron's unit of work changed from "an agency" to "a credential set"**
  (`syncCredentialSet(orgId, platformPool)`): each agency is synced against
  its own portfolio for the accounts it owns, and the pool is synced once
  against the platform's credentials. Comparing a portfolio against rows it
  does not contain would report every one of them as "new to import" and never
  rename any of them. The pool digest notification fans out to each agency
  holding grants (never a cross-tenant broadcast); Telegram still fires for
  org zero only. `syncAdAccountName()` now takes an explicit
  `auditOrganizationId` — a pool account has no org of its own, but
  `audit_logs.organization_id` is NOT NULL, so `operatingOrganizationId()`
  resolves the granted agency. Same fix in `syncAndPersistAdAccountSpendCap()`
  for its audit row and its `notifyAdmins()` call, and in
  `retryPendingMetaSpendCapSyncs()`, whose `.in('organization_id', …)` sweep
  would otherwise have silently skipped every granted account.
  **Behaviour change worth knowing**: pool accounts survive an agency's
  Settings -> "Clear all data". An agency clearing its own data must not
  destroy an account the platform merely granted it; the grant survives too,
  so the account returns unassigned rather than disappearing. Only accounts
  the agency owns outright are wiped.
  Panel: `/platform/ad-accounts` (`listPoolAccountsFn` / `grantPoolAccountFn` /
  `revokePoolAccountFn`, all `requirePlatformAdmin`), audited as
  `PLATFORM_ACCOUNT_GRANTED` / `PLATFORM_ACCOUNT_REVOKED`. Granting is
  push-only — agencies have no screen to browse or request pool accounts, as
  instructed. Each account row in the agency UI carries an **"Own" vs
  "Platform assigned"** badge (list page and the detail page's Account details
  card).
  **Verified**: a real integration test against the live project,
  `src/server/ad-accounts/pool-isolation.test.ts` (8 tests) — seeds two
  throwaway agencies, grants a pool account to A only, and asserts B never
  sees it through the scoped list, never through a by-id read (and gets the
  same "not found" as for a missing row), while still seeing the account it
  owns outright; plus revoke/re-grant moving it, the UNIQUE constraint
  refusing a double grant, and a regression test that org zero sees exactly
  its 34 accounts. It `describe.skipIf`s when no credentials are present, so
  `npm test` stays green without database access — consistent with this
  repo's unit-vs-live split rather than replacing it. Also verified in a real
  browser: the pool panel lists all 34 granted to xRush, and xRush's own
  `/admin/ad-accounts` still shows all 34 with live Meta data intact, zero
  console errors. `npm test`: 65/66 (same single pre-existing
  `permissions.test.ts` failure).
  **Rate limits, noted not addressed** (out of scope, as instructed): the
  whole pool now runs through one shared Meta app/token. At 34 accounts the
  cron makes 2 Graph calls for the entire pool, so this is nowhere near a
  concern yet; it would become one only if the pool grows into the thousands
  or per-account insight calls are added later.
- **Meta integration is now per-organization (post-Phase-8 addition): done,
  pending owner review. Migration `20260723000034` confirmed applied to the
  live project** (via `supabase db push`; `app_settings` verified empty
  afterwards — xRush's credentials live in env vars, not DB rows, so the
  backfill was a no-op in practice). Closes the gap Phase 1B explicitly
  deferred and the gap audit called the biggest one left.
  `app_settings` is re-keyed from `key` to `(organization_id, key)`; the
  `organization_id` column is added WITH a default of org zero (so every
  existing row carries over in one metadata-only statement) and the default
  is then **dropped** — unlike the 17 tables in migration 000031, this table
  has exactly one writer (`updateIntegrationSettingsFn`, updated in the same
  pass), so a lingering default would be a way for a bug to overwrite
  xRush's live API token with another agency's, not a safety net. RLS stays
  enabled with zero policies, unchanged.
  **SUPERSEDED 2026-09-15 — the env vars are the PLATFORM's credentials now,
  not org zero's; see "Meta integration transferred from xRush Agency to the
  PLATFORM" above. The isolation rule itself still holds (no agency may borrow
  another scope's credentials); only the owner of the env vars changed.** The
  paragraph as originally written: the
  `META_SYSTEM_USER_TOKEN` / `META_BUSINESS_ID` env vars are **org zero's
  credentials only** (`DEPLOYMENT_ORGANIZATION_ID`, shared constant in
  `src/lib/organizations/deployment-org.ts`). They are set on the deployment
  by the deployment's owner and point at xRush's Business Portfolio. A
  global env fallback — which is what the single-tenant code did — would
  mean a newly-created agency with no credentials silently falls back to
  them: seeing xRush's ad accounts, and able to **write spend caps to
  them**. An agency with no credentials of its own now has no Meta
  integration, and `MetaNotConfiguredError` carries a different message for
  each case. The Graph API *version* is deliberately NOT gated this way —
  it's a protocol version, not tenant data, so every agency may use the
  deployment default unless it pins its own.
  `getMetaConfig(organizationId)` plus `fetchMetaAdAccount`,
  `listMetaBusinessAdAccounts` and `updateMetaAdAccountSpendCap` all take an
  organization id now. Admin call sites use `actor.organizationId`; the
  client-portal one (`listMyAccountsMetaRemainingFn`) uses
  `user.organizationId`; `syncAdAccountSpendCap` takes it from the
  `ad_accounts` row's **own** `organization_id`, so an account can only ever
  be pushed to the portfolio of the agency that owns it. No client-side code
  changed — every UI path already went through a guarded server fn. New
  `isMetaConfigured(organizationId)` exists for the cron's skip check.
  Note `organization_id` is a column but NOT a field on the `AdAccount`
  domain type; `syncAdAccountSpendCap`'s parameter intersects it in rather
  than widening `AdAccount` app-wide.
  **The daily cron (`syncMetaAdAccounts`) was rewritten to iterate
  organizations** — `syncOneOrganization(orgId)` is the old body, now
  filtered to one agency's `ad_accounts` and using that agency's
  credentials; the outer loop walks every **active** organization, skips
  ones with no credentials as `not_configured` (normal, not an error), and
  catches per-agency failures as `skipped/failed` so one customer's expired
  token can't stop everyone else's sync. Return type changed from
  `MetaSyncResult` to `MetaSyncRunResult` (`{ organizations[], skipped[] }`);
  the cron route passes it straight through as JSON.
  **Suspended agencies are now skipped** by both the sync and
  `retryPendingMetaSpendCapSyncs()` — their users are locked out of the app,
  so acting on their Meta account nightly (and spending their API quota) was
  wrong. Open item from the gap audit, closed here.
  **Telegram alerts fire for org zero ONLY** (`alertTelegram()`): there is
  one `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` on the deployment and it
  belongs to xRush, so sending another agency's account names and balances
  there would leak their data to us. Other agencies get the in-app
  notification, which `notifyAdmins({ organizationId })` already scopes
  correctly. Per-agency Telegram is a separate feature (each agency would
  register its own bot/chat, as they now do their own Meta credentials) and
  is deliberately NOT inferred here.
  `getIntegrationSettingsFn` returns `{ fields, hasEnvFallback }` instead of
  a bare array, so the Settings card's copy can tell the truth in both
  cases — "Overrides the META_* environment variables" is meaningless and
  misleading for an agency that has no env vars.
  **Also fixed, found only by looking at the rendered page**: the "Import
  from Meta" dialog had no error branch, so a failed fetch fell through to
  its empty state and told an agency with no portfolio connected that
  "everything in the Business Portfolio is already linked" — confidently
  wrong, and it hid the one action they needed. It now renders the error
  (which names the fix) and the query no longer retries.
  **Verified live against the real project** with a throwaway second agency
  (temporary Playwright + magic-link, removed after, zero lockfile diff):
  xRush's 34 ad accounts and Meta data load exactly as before (no
  regression) and its Settings still shows "Environment variable"; the
  second agency's Settings shows token and Portfolio ID **"Not set"** with
  the per-agency copy (only API version shows the env badge, by design); its
  "Import from Meta" shows the not-configured message with **zero of
  xRush's accounts leaking**. The cron endpoint was invoked for real against
  production: xRush synced (36 checked, 2 new available), Arrow Solutions
  and the throwaway both skipped as `not_configured` — i.e. neither borrowed
  xRush's token. Throwaway agency and user deleted afterwards; zero console
  errors. `npm test` 50/51 (one test added asserting the account's own org
  id reaches both Meta calls; same single pre-existing failure).
- **Deactivate / delete an agency admin from the platform panel
  (post-Phase-8 addition): done, pending owner review, no migration.**
  Requested as a delete button on the agency profile's "Who to contact"
  rows; shipped as a row dropdown with **Deactivate/Activate** and **Delete
  login**, because delete alone would fail for most real admins.
  **The schema fact that drives this design**: every FK to `auth.users` in
  this schema (`limit_requests.reviewed_by`, `payments.reviewed_by`,
  `adjustments.created_by`, `ledger_entries.created_by`,
  `ad_account_assignments.assigned_by`/`released_by`,
  `attachments.uploaded_by`, `audit_logs.actor_user_id`, …) was declared
  with **no ON DELETE clause**, i.e. NO ACTION — so Postgres refuses to
  delete any account that has approved, adjusted or assigned anything.
  Only `user_profiles.user_id` and `notifications.user_id` cascade. That is
  correct and deliberate (financial records must keep naming a real
  person), so deletion is only ever possible for an account that has never
  acted — the "added by mistake / duplicate" case.
  `setOrganizationAdminStatusFn` is therefore the action for everyone else:
  an INACTIVE profile fails `loadSessionUser()`, so access is revoked
  immediately while every record stays intact, and it's reversible.
  `deleteOrganizationAdminFn` pre-checks `audit_logs.actor_user_id` (every
  write path in this app records one, so it's effectively a superset of the
  other references) and refuses with a count plus "deactivate instead",
  rather than letting an FK violation surface as an opaque Supabase auth
  "database error"; the raw error is still translated to the same advice if
  something outside the audit trail holds a reference. Both fns scope to
  the (organization, user) pair via a double `.eq()` (same discipline as
  `setClientMembershipStatusFn`), refuse the caller's own account, and
  refuse any profile flagged `is_platform_admin` — a shared
  `loadOrganizationAdmin()` enforces all of that in one place. The UI hides
  the menu entirely for those two cases rather than relying on the server
  error alone. Audited as `ORGANIZATION_ADMIN_STATUS_CHANGED` /
  `ORGANIZATION_ADMIN_DELETED`.
  **Deleting an agency's last admin is warned, not blocked** — the dialog
  says the agency can't sign in until another is added. Cleaning up a
  mistake is legitimate and `createOrganizationAdminFn` (entry below) makes
  it recoverable, so it's no longer a one-way door; `deleteClientFn`/
  `deleteEmployeeFn` hard-block by comparison because those risk *data
  loss*, which this doesn't.
  `OrganizationProfile.admins` gained `is_platform_admin` for the UI gate.
  **Verified live through the real UI** against a throwaway agency with two
  seeded admins, one given a recorded action (same temporary Playwright +
  magic-link technique, removed after, zero lockfile diff): deactivate →
  `INACTIVE`, reactivate → `ACTIVE`, delete correctly refused for the admin
  with history (account still present), delete succeeded for the clean one
  (profile row cascaded away), last-admin warning renders, and the platform
  admin's own row on xRush's profile correctly renders no actions button.
  All three audit rows correct. Throwaway agency, users and audit rows
  deleted afterwards; zero console errors.
- **Add a Super Admin to an existing agency from the platform panel
  (post-Phase-8 addition): done, pending owner review, no migration.** The
  agency profile's "Who to contact" card showed "No admin logins — this
  agency can't sign in" with no way to act on it; an agency created without
  an admin, or one that lost access to every admin account it had, needed
  hand-written SQL — the exact thing `createOrganizationFn` was built to
  remove. New `createOrganizationAdminFn` (`requirePlatformAdmin`), wired to
  an "Add admin" button in that card's header and a matching one in its
  empty state.
  The user-provisioning half of `createOrganizationFn` is now the shared
  `provisionOrganizationSuperAdmin()` — both onboarding and this path set
  `organization_id` + `role_id` explicitly (the `handle_new_user()` trigger
  defaults every new account to org zero as CLIENT, so an admin created
  without them is in the wrong agency AND can't administer anything), and
  never `is_platform_admin`. The helper deletes its own half-created auth
  user if the profile update fails; `createOrganizationFn`'s catch now only
  rolls back the organization row it owns. Email availability is checked up
  front by a shared `assertEmailAvailable()` before anything is created.
  **Deliberately not gated to agencies with zero admins, and this is the
  boundary to understand**: the login this creates is a full SUPER_ADMIN of
  that agency and can read its clients and ledger — which no platform screen
  can (see the aggregate-only profile entry above). A zero-admin gate would
  strand an agency whose only admin is locked out, so the control is
  accountability instead: audited as `ORGANIZATION_ADMIN_CREATED` naming the
  acting platform admin, the agency, and the email granted access, and the
  dialog states what the login can see rather than leaving it implied.
  **Framework gotcha, cost a build**: `type X = ReturnType<typeof
  getSupabaseAdminClient>` at the top of a `.fns.ts` file fails the client
  build — a type alias referencing that binding keeps the `*.server` import
  alive after the handler bodies are compiled out, and import protection
  rejects it. Type such parameters as `SupabaseClient` imported from
  `@supabase/supabase-js` instead; the comment above that import says so.
  Also fixed while verifying: the "Who to contact" table's four columns
  clipped the Status badge off the right edge of its half-width card — email
  now sits under the name (3 columns).
  **Verified live through the real UI** against a throwaway organization
  (same temporary Playwright + magic-link session technique used elsewhere
  in this file, installed with `--no-save` and removed after — confirmed
  zero `package.json`/lockfile diff): empty-state button renders and opens
  the dialog; the created admin's profile has the throwaway org's
  `organization_id`, `SUPER_ADMIN`, and `is_platform_admin: false`; the
  audit row is correct; a second submission with the same email is refused
  with no new auth user created. Throwaway organization, user and audit row
  all deleted afterwards (confirmed xRush Agency and the owner's own "Arrow
  Solutions" are the only remaining organizations, no orphaned profiles);
  zero console errors.
- **CSS cascade-layer bug fixed: active sidebar nav text was invisible
  (post-Phase-8 addition): done, pending owner review, no migration** — a
  bare `a { color: var(--link) }` in `styles.css` sat outside every
  Tailwind `@layer`, so it always beat any `text-*` utility (Tailwind
  wraps its own utilities in `@layer utilities`) regardless of class
  order — this silently overrode the intended text color on every
  `<Link>`/`<a>` app-wide, not just the sidebar. Harmless-looking before
  the financial-ledger rebrand (`--link` and `--primary` were different
  hues); once that rebrand gave them the same blue, the active nav pill's
  text became literally invisible (blue on blue). Fixed by moving the rule
  into `@layer base` so Tailwind's utility layer wins as intended. Also
  added `suppressHydrationWarning` to `<html>` for the theme-init script's
  expected pre-hydration `data-theme` mismatch. Verified live in both
  themes; zero console errors.
- **Ad account "Per USD" now shows the effective (resolved) rate, not just
  the account's raw column (post-Phase-8 addition): done, pending owner
  review, no migration** — the ad accounts list, the client detail page's
  Ad Accounts tab, and the ad account detail page's Account details card
  all previously showed `ad_accounts.usd_rate` directly, never falling
  back to the client's own rate the way real billing
  (`adAccountUsdRate()`, `rate.service.ts`) already does — so every
  account looked pinned at whatever it was bulk-imported at, regardless of
  which client actually held it. `AdAccountClient` (`types/domain.ts`)
  gained `usd_rate`; `currentClientMap()` (`ad-account.fns.ts`) and
  `listClientAccountsFn` (`assignment.fns.ts`) now select it so all three
  surfaces can resolve the same account-overrides-client fallback
  client-side without new queries. Inherited (vs. account's own override)
  is shown italicized. Live data confirmed the underlying cause the
  earlier USD-rate-inheritance entry above already flagged: literally
  every one of the 33 ad accounts still carried an explicit non-zero
  `usd_rate` from the old bulk import, so the display fix alone didn't
  change anything visible for most rows. Owner confirmed clearing the two
  currently-assigned accounts whose stale ৳130 override didn't match
  their real client's rate — `ADA-0018` (client xRush Agency, real rate
  ৳1) and `ADA-0014` (client Foysal bhai, real rate ৳129) — done through
  the real Edit dialog (`updateAdAccountFn`, proper audit trail), not a
  raw DB write. Verified live: both now `usd_rate: 0` (inherit), correct
  `AD_ACCOUNT_UPDATED` audit rows, list shows ৳1/৳129 in italics. The
  other 31 accounts' ৳130 was left as-is — their clients are genuinely
  configured at ৳130 too.
- **Billed vs. Paid & Due donut chart on the Client Due Report
  (post-Phase-8 addition): done, pending owner review, no migration** —
  requested as "a pie chart for billed, paid and current due." Built as a
  2-segment donut (Paid, Current Due) with Billed shown as the center
  total, not a literal 3-slice pie — Billed = Paid + Current Due
  (ledger-derived, spec §35), so plotting all three as independent slices
  would double-count the whole. `src/components/reports/
  due-breakdown-donut.tsx`, pure SVG (no new chart-library dependency),
  totals summed client-side from the report's own rows via decimal.js.
  Hover/focus on a segment or its legend row swaps the center label to
  that segment's value + percent (same behavior for mouse and keyboard,
  avoids floating-tooltip positioning entirely); every value is also
  visible at rest in the legend and in the per-client table right below,
  never color-alone. New `--chart-paid`/`--chart-due` tokens
  (`styles.css`) — light mode reuses `--success`/`--warning`, but dark
  mode needed distinct, deliberately deepened hexes (`#2f9968`/`#b07f2a`)
  since the existing dark `--success`/`--warning` fail the lightness-band
  check as large chart fills; colorblind-safety validated both modes with
  the dataviz skill's `validate_palette.js` before shipping (light mode
  passes outright; dark mode's CVD separation lands in the 6–8 "floor"
  band, legal only alongside the always-visible labels this chart already
  has). Verified live in both themes, zero console errors.
- **Edit amount before approving a payment (postpaid/partial clients)
  (post-Phase-8 addition): done, pending owner review, migration NOT YET
  APPLIED to the live project** — lets an admin correct a payment's amount
  before it's credited, e.g. when the proof shows a different figure than
  what the client typed on submission. `approve_payment` (the app's
  designated admin-override point — already documented as staying
  override-capable by design, unlike the client-side submission race fix)
  gained an optional `p_amount_bdt` parameter: when provided it updates
  `payments.amount_bdt` and that figure drives the ledger credit, still
  inside the same row-locked transaction. Migration
  `20260723000024_approve_payment_amount_override.sql` drops + recreates
  the function (Postgres requires this for a signature change — same
  pattern as the earlier `approve_limit_request` change).
  `approvePaymentFn` only sends `p_amount_bdt` when an admin actually
  edits the amount, so a plain approval still matches the pre-migration
  2-parameter signature — normal approvals keep working even before the
  migration lands; only the new edit itself needs it.
  UI: `/admin/payments/$paymentId`'s Verify card — "Amount to credit" with
  an Edit button, shown only when the payment's client is `postpaid` or
  `partial`, not `prepaid` (a prepaid client's payment is auto-recorded by
  `approve_limit_request` to exactly match that request's frozen
  `amount_paid_bdt`; editing it here would silently desync the two).
  **Real bug found and fixed during verification**: seeding the edit
  field via `setAmountDraft(payment.amount_bdt)` crashed with
  `amountDraft.trim is not a function` — Supabase returns `numeric`
  columns as JS numbers at runtime despite the TS type saying `string`,
  the same class of bug already found and fixed once this session
  (`usd_rate`/`current_limit_usd`). Fixed with `String(...)`. Verified
  live against a real pending payment (`PAY-000010`, DF IT Solutions,
  ৳39,000): Edit button appears, input pre-fills, `0` correctly disables
  Approve with a visible error, a valid edit re-enables it and updates the
  confirmation text — deliberately did not click Approve itself, since
  that would irreversibly credit a real client's ledger. **Owner must
  apply the migration via the SQL editor or `supabase db push`** before
  using this — no DB connection is available in this dev environment to
  apply it directly.
- **Ad account "Threshold" field, manual/admin-only (post-Phase-8
  addition): done, pending owner review, migration NOT YET APPLIED to the
  live project** — mirrors Meta's own "you'll pay when your balance
  reaches $X" auto-charge trigger, shown on the ad account detail page's
  billing screenshot the owner provided. **Confirmed live against the real
  Graph API before building anything**: fetched a real linked account with
  an expanded field list and separately probed every plausible field name
  (`billing_threshold`, `bill_amount`, `threshold`, `payment_threshold`,
  `min_billing_threshold`, `next_bill_date`, `next_bill_amount`,
  `current_bill_amount`) — all rejected as nonexistent fields by the API
  itself, confirming this value is genuinely not exposed anywhere in the
  Marketing API (it only lives in Meta's own billing-settings UI). So it's
  a plain admin-entered reference value, same treatment as
  `current_limit_usd` — no live-data relationship to anything Meta-fetched,
  never synced or compared against a Meta figure.
  New `ad_accounts.threshold_usd` column (migration
  `20260723000025_ad_account_threshold.sql`, `numeric(18,2) not null
  default 0 check (>= 0)`, same shape/precision as `current_limit_usd`).
  Added to `adAccountCreateSchema`/`adAccountUpdateSchema` (reusing the
  existing `usdAmount` validator — it's already generic) and to both the
  create/update payloads in `ad-account.fns.ts` — both gated by the
  existing `requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)`, no new
  permission introduced since this is just one more field on the same
  admin-only account form. Editable only through the existing admin
  Create/Edit dialogs (`account-dialogs.tsx`) — followed the same
  `String(...)`-wrapped `defaultValues`/`form.reset()` pattern already
  used for `current_limit_usd`/`usd_rate` there (see the "a client's own
  USD rate was silently ignored" and "Edit amount before approving a
  payment" entries above for why that wrapping matters). Shown as a new
  **"Threshold"** column on `/admin/ad-accounts`, placed immediately after
  "Meta Due" per the request (`formatUsd`, `—` when unset/0 — a stored
  value, so no currency-native `formatCurrencyAmount` needed, unlike
  Remaining/Meta Due which read live Meta data), and as a new "Threshold"
  row on the ad account detail page's Account details card (after
  "Current limit"). **Owner must apply the migration via the SQL editor or
  `supabase db push`** — no DB connection is available in this dev
  environment to apply it directly (though read-only access via the
  service-role key confirmed `app_settings` has no config override and
  supplied real ad account ids for the live Graph API probe above).
- **Finance: USD buy/sell margin tracking (post-Phase-8 addition): done,
  pending owner review, migration confirmed applied to the live project** —
  a new, genuinely separate bookkeeping layer for the agency's own forex
  spread revenue (buy USD to fund Meta ad spend, sell to clients at a
  markup). Built in two explicit steps at the owner's request: schema
  first (reviewed before any backend/UI landed), then this pass.
  **Schema investigation found, and flagged before building anything**: no
  "buy rate" (what the agency itself pays for USD) exists anywhere in the
  prior schema — the only rate on `ledger_entries` (`usd_rate`) is the
  *sell* side, snapshotted from `limit_requests.approved_usd_rate` at
  approval. And `clients.usd_rate` (the live scalar real billing already
  uses, `rate.service.ts`) is a **separate thing** from the new
  `client_usd_rates` history table below — nothing wires them together
  automatically; `clients.usd_rate` stays the billing source of truth,
  `client_usd_rates` is a parallel margin-tracking record populated on its
  own. Two new tables (migration
  `20260723000026_finance_usd_margin.sql`): `client_usd_rates`
  (`client_id`, `sell_rate`, `effective_from`/`effective_to` date range,
  `created_by → employees` — deliberately the `employees` table, not
  `auth.users`, per the owner's explicit schema spec, since "who recorded
  this rate" is a staffing concept, not a login concept; nullable, since
  no table links a signed-in admin's `auth.users` row to an `employees`
  row) and `usd_margin_entries` (`client_id`, optional `ledger_entry_id`,
  `usd_amount`, `buy_rate`, `sell_rate`, `margin_bdt` — DB-generated
  `usd_amount * (sell_rate - buy_rate)`, `stored`, never computed
  client-side). Both are SELECT-only RLS (no write policies, same
  convention as every other table), gated by two new sensitive
  permissions — `finance.view` / `finance.manage`, SUPER_ADMIN-only by
  default (same treatment as `adjustments.create`/`exchange_rate.manage`/
  `users.manage`/`integrations.manage`) since profit-margin data is more
  sensitive than typical admin data; an ADMIN can be granted either
  individually via the existing Users screen.
  Backend (`src/server/finance/finance.fns.ts`): list/create for both
  tables, `requireAdmin(FINANCE_VIEW/MANAGE)`, audited as
  `CLIENT_USD_RATE_RECORDED` / `USD_MARGIN_ENTRY_RECORDED`.
  **Deliberately insert-only from the UI** (no edit/delete) — matches this
  codebase's broader "financial-ish records don't get mutated, only added"
  ethos (adjustments/reversals, ledger entries) even though nothing forced
  that choice here; flagged as a judgment call, not something the owner
  asked for explicitly. `createClientUsdRateFn` auto-closes a client's
  prior open-ended (`effective_to is null`) rate the day before a new
  one's `effective_from`, so at most one "currently active" rate exists
  per client at a time rather than two open-ended rows silently coexisting.
  `margin_bdt` is never sent from the client — the dialog only shows a
  client-side preview of what the DB will compute, using the same `dec()`
  decimal.js helper as everywhere else in this app.
  UI: new `/admin/finance` page (nav item added to `ADMIN_NAV`, unconditionally
  shown like Settings/Users — the page itself gates on `finance.view` and
  shows a plain access-denied card instead of firing queries when missing,
  same pattern Settings uses for `integrations.manage`), two tabs (Margin
  Entries / Sell Rates) each with a create dialog, plus a "Total margin
  recorded" summary card (client-side sum of `margin_bdt`, red/emerald by
  sign). **Deliberately did not build a ledger-entry picker** for
  `usd_margin_entries.ledger_entry_id` — it's optional/nullable and left
  unset from this UI for now (searching/selecting a specific ledger row is
  real complexity, cut from this pass rather than guessed at).
  Does not touch `ledger_entries`, `payments`, `limit_requests`, or any
  Meta spend-cap logic, as instructed — purely additive.
- **Finance refined: USD purchase ledger / cost basis (post-Phase-8
  addition): done, pending owner review, migration NOT YET APPLIED to the
  live project** — owner asked to "recheck and refine" the Finance
  feature into a "properly accounts solution." Asked which of three
  concrete directions they meant (a purchase/inventory ledger with no
  change to existing flows; full auto-generation of margin entries from
  `approve_limit_request`, which would have required touching it despite
  the original "don't touch" instruction; or a reports-only pass with no
  new tables) rather than guessing, since two of the three conflicted with
  that earlier constraint. Owner picked the purchase-ledger option.
  New table `usd_purchases` (migration
  `20260723000027_finance_usd_purchases.sql` — additive on top of, not a
  change to, the already-applied `20260723000026` tables): `purchase_date`,
  `usd_amount`, `buy_rate`, `cost_bdt` (DB-generated,
  `usd_amount * buy_rate`), `source`, `note`, `created_by → employees`
  (same nullable-FK-to-employees-not-auth.users reasoning as
  `client_usd_rates.created_by` above). New `usd_inventory_summary()`
  function (same read-only-aggregate pattern as `client_financials()`):
  total purchased, total sold (summed from `usd_margin_entries`),
  available balance, and weighted-average cost across every purchase ever
  recorded. SELECT-only RLS, reuses the existing `finance.view`/
  `finance.manage` permissions — no new permission introduced.
  `src/server/finance/finance.fns.ts` gained `listUsdPurchasesFn`,
  `createUsdPurchaseFn`, `getUsdInventorySummaryFn`
  (`requireAdmin(FINANCE_VIEW/MANAGE)`, audited as
  `USD_PURCHASE_RECORDED`). New "USD Purchases" tab on `/admin/finance`
  with its own create dialog, plus "Available USD inventory" and
  "Weighted-avg. cost" stat cards alongside the existing margin total.
  The margin-entry dialog now prefills `buy_rate` from the live
  weighted-average cost the moment it loads (only if the admin hasn't
  already typed their own value — a specific sale can genuinely be priced
  off a specific batch, not always the running average) and shows a soft
  warning, not a hard block, when the USD amount being recorded as sold
  exceeds what `usd_inventory_summary()` says is actually available —
  **deliberately not enforced at the database level**: real purchase
  timing can lag a sale by hours or days, and nothing asked for a strict
  inventory constraint. Flagged explicitly as revisitable if the owner
  wants oversell blocked outright later. Still purely additive — no
  change to `ledger_entries`, `payments`, `limit_requests`, or Meta logic.
  `npm run typecheck` and `npm run build` both pass. **Owner must apply
  this migration via the SQL editor or `supabase db push`** — no DB
  connection is available in this dev environment to apply it directly
  (though read-only access via the service-role key was used to confirm
  the prior `20260723000026` migration was already live, and that
  `finance.view`/`finance.manage` were correctly NOT granted to ADMIN's
  role_permissions, before building this on top of it).
- **`usd_purchases.purchase_date` now carries time-of-day (post-Phase-8
  addition): done, pending owner review, migration NOT YET APPLIED to the
  live project** — owner asked to add time to the purchase date field.
  Checked live first (via the service-role key) whether
  `20260723000027`'s `usd_purchases` table had already been applied —
  it had, table existed and was empty — so this is a follow-up `alter
  column purchase_date type timestamptz` (migration
  `20260723000028_usd_purchases_datetime.sql`), not an edit to the
  already-run migration file. Scoped to exactly the column the owner's
  selection pointed at: `usd_margin_entries.transaction_date` and
  `client_usd_rates.effective_from`/`effective_to` are untouched and stay
  date-only. `CreatePurchaseDialog` switched from a `date` input to a
  `datetime-local` one (defaults to the current local date/time,
  converted to a real UTC ISO timestamp via `new Date(...).toISOString()`
  on submit — the naive `datetime-local` string is never sent directly,
  avoiding a timezone-ambiguous write); the Purchases tab's date column now
  shows date + time (`fmtDateTime()`, new — the page's existing `fmtDate()`
  stays for the still-date-only fields). `npm run typecheck` and `npm run
  build` both pass. **Owner must apply this migration** the same way as
  the others — no DB connection available in this dev environment.
- **Finance rebuilt — the rate/inventory model above was the wrong concept,
  replaced outright (post-Phase-8 addition): done, pending owner review,
  migration NOT YET APPLIED to the live project.** Supersedes the three
  Finance entries directly above (`finance_usd_margin`,
  `finance_usd_purchases`, `usd_purchases_datetime`) — client sell-rate
  history and the USD purchase/inventory ledger are both **gone**, not
  extended. Owner's direction: one row per USD transaction — USD amount,
  buying amount (total BDT paid), selling amount (total BDT received) —
  margin is `selling - buying`, no rates, no per-client link, no inventory
  tracking. Also needed margin visible grouped by 15 days / weekly /
  monthly / 6 months / yearly, which the old design had no path to at all.
  **Checked live before dropping anything**: `client_usd_rates` and
  `usd_margin_entries` each held exactly one row, matching the owner's own
  test values visible in a screenshot from trying the old UI (not real
  data) — confirmed via the service-role key, not assumed.
  Migration `20260723000029_finance_rebuild.sql` drops `client_usd_rates`,
  `usd_purchases`, `usd_inventory_summary()` outright, and drops +
  recreates `usd_margin_entries` with the new shape: `transaction_date`
  (date), `usd_amount`, `buying_amount_bdt`, `selling_amount_bdt`,
  `margin_bdt` (generated, `selling_amount_bdt - buying_amount_bdt`). Kept
  the table name since the concept is the same ("margin entries"), just
  restructured. `finance.view`/`finance.manage` permissions unchanged —
  still the only gate, no new permission. The prior migration files
  (`20260723000026`–`028`) are left in place as history, per this repo's
  convention of layering corrective migrations rather than rewriting past
  ones (same pattern as the segment-split migrations).
  Deleted `create-client-rate-dialog.tsx` and `create-purchase-dialog.tsx`
  (no longer applicable). `finance.fns.ts` trimmed to just
  `listUsdMarginEntriesFn`/`createUsdMarginEntryFn` — no client filter, no
  employee lookups, no inventory RPC. `create-margin-entry-dialog.tsx`
  rewritten to exactly 3 inputs + date, with a live client-side margin
  preview (decimal.js, matching the DB's generated-column formula).
  `/admin/finance` is now a single page, no tabs (one entity, not three):
  a total-margin card, a new "Margin by period" table driven by a
  granularity `Select` (15 Days / Weekly / Monthly / 6 Months / Yearly),
  and the raw entry list below it. Grouping is pure client-side
  (`groupByPeriod()`/`bucketFor()` in the route file) over the already-
  fetched list (`listUsdMarginEntriesFn`, limit raised to 500 rows) — no
  new query per granularity choice, no new RPC.
  **Bucket boundary choices, flagged as judgment calls the owner should
  correct if wrong**: "15 Days" is semi-monthly (1st–15th, 16th–end of
  month — the common payroll/billing convention for that phrase) rather
  than a rolling 15-day window from an arbitrary anchor; "Weekly" buckets
  start Monday; "6 Months" is calendar halves (Jan–Jun, Jul–Dec), not a
  rolling 6-month window either. None of these were specified explicitly,
  so all three are the most standard interpretation, not verified against
  what the owner actually pictured. `npm run typecheck` and `npm run
  build` both pass. **Owner must apply this migration** — no DB connection
  available in this dev environment.
- **Margin entry: buying/selling rate inputs, amounts now DB-computed
  (post-Phase-8 addition): done, pending owner review, migration NOT YET
  APPLIED to the live project** — owner asked to put a rate field before
  each amount field, with the amount auto-filled by calculation rather
  than typed directly. Checked live first (confirmed `20260723000029` was
  already applied and the table still empty), so migration
  `20260723000030_finance_rates.sql` is another safe drop-and-recreate,
  not an in-place edit — same precedent as the two rebuilds above.
  `usd_margin_entries` gains `buying_rate`/`selling_rate` (real,
  admin-entered `numeric(10,4)` columns); `buying_amount_bdt`/
  `selling_amount_bdt` switch from plain input columns to DB-generated
  ones (`round(usd_amount * rate, 2)`). `margin_bdt`'s generated
  expression is written directly from `usd_amount`/`buying_rate`/
  `selling_rate`, not from the two amount columns — Postgres doesn't allow
  a generated column to reference another generated column, so chaining
  amount → margin the way the UI conceptually does isn't possible at the
  DB layer; the math still comes out identical
  (`usd_amount * (selling_rate - buying_rate)` ≡
  `usd_amount*selling_rate - usd_amount*buying_rate`).
  `CreateMarginEntryDialog` (`components/admin/finance/`) now has a Buying
  rate input followed by a disabled, live-computed Buying amount field,
  and the same pairing for Selling — decimal.js computes the preview
  client-side, and the database's own generated columns compute the real
  stored value again on save (never trusts the client-side preview as the
  source of truth, same rule as every other money computation in this
  app). `npm run typecheck` and `npm run build` both pass. **Owner must
  apply this migration** — no DB connection available in this dev
  environment.
- **Payment dates now show time, admin + portal (post-Phase-8 addition):
  done, pending owner review, no migration** — `payments.created_at` was
  already `timestamptz`; both `/admin/payments` and the portal's `/portal/
  due` Payment history table only ever displayed the date part of it. Both
  routes' local `fmtDate()` became `fmtDateTime()` (zero-padded 12-hour
  time + lowercase am/pm, e.g. "Sep 1, 2026, 04:30 pm") — same custom
  formatter style already established by `fmtApprovalDateTime()` on the
  client detail page's Limit Requests tab, not `Intl.DateTimeFormat`'s
  locale-default AM/PM styling. The admin payment detail page
  (`$paymentId.tsx`) doesn't render a date at all, so it was left
  untouched. `npm run typecheck` and `npm run build` both pass.
- **"Notes" column on both payment lists (post-Phase-8 addition): done,
  pending owner review, no migration** — `listPaymentsFn` (admin) and
  `listMyPaymentsFn` (client) already selected `admin_note`/
  `rejection_reason` (used on the admin detail page and in the reject
  dialog respectively); neither list table rendered them. New "Notes"
  column on `/admin/payments` and `/portal/due`'s payment history table:
  `admin_note ?? rejection_reason ?? '—'`. No new data exposure — the
  client-facing fn was already shipping this field to the browser bundle,
  just not displayed. `npm run typecheck` and `npm run build` both pass.
- **"Meta Due" summary card, portal dashboard + admin client detail page
  (post-Phase-8 addition): done, pending owner review, no migration** —
  sits right after "Total Remaining" in both places, same pairing as the
  per-row Remaining/Meta Due columns already shown elsewhere.
  `listMyAccountsMetaRemainingFn` (`meta.fns.ts`, the client-scoped Meta fn
  behind the portal's existing "Remaining" column/card) now also returns
  `meta_balance` per account — same bulk Graph API fetch already made, no
  new call. Also relaxed its per-row gate from requiring `spend_cap` to
  requiring only a matched Meta account, mirroring the admin-side
  `balanceByAccountId` fix from the "Double red bell" entry above: an
  account can carry a Meta bill balance with no spend cap set, and the old
  gate silently hid it. Portal (`portal/index.tsx`) sums `meta_balance`
  across the client's own USD-currency linked accounts into a new "Meta
  Due" card. Admin (`$clientId.tsx` + `financial-summary.tsx`):
  `FinancialSummary` gained a `totalMetaDueUsd` prop/card;
  `$clientId.tsx` computes it the same way `totalRemainingUsd` already is,
  from the same `balanceByAccountId` map the Ad Accounts tab's per-row Meta
  Due column already builds — no new query. Both cards USD-only (no FX
  path, same gate as every other Meta-money aggregate here), hidden rather
  than shown as a misleading "$0.00" until the data resolves. `npm run
  typecheck` and `npm run build` both pass.
- **Multi-tenant subscription conversion — Phase 1 of 4 (schema + RLS
  foundation): done, pending owner review. Confirmed applied to the live
  project** (via `supabase db push` — the CLI's migration-history bookkeeping
  had to be reconciled first with `supabase migration repair --status
  applied` for every prior migration, since 000001–000030 were all
  originally applied by hand through the SQL editor and the CLI had no
  record of them; verified directly afterward: `organizations` has exactly
  one row, "xRush Agency"; the target account's `is_platform_admin` is
  true; all 6 live clients backfilled to org zero's id). Rush Tracker is
  becoming a subscription product sold to
  other agencies; each customer needs isolated data and the owner needs a
  cross-org panel to activate/suspend access manually (no payment gateway).
  Scoped as 4 phases, not the 3 originally requested — see below for why.
  New `organizations` table (`id`, `name`, `subscription_status` — active/
  suspended/cancelled, `plan`, `notes`, `suspended_at`, `created_at`).
  Migration `20260723000031_multi_tenant_foundation.sql` seeds org zero
  ("xRush Agency", this agency's own row, fixed id
  `00000000-0000-0000-0000-000000000001`) and adds `organization_id` to
  every agency-scoped table: `user_profiles`, `clients`,
  `client_memberships`, `ad_accounts`, `ad_account_assignments`,
  `limit_requests`, `ledger_entries`, `attachments`, `payment_requests`,
  `payments`, `adjustments`, `exchange_rates`, `employees`,
  `client_employees`, `notifications`, `usd_margin_entries`, `audit_logs` —
  17 tables. Deliberately **not** scoped: `roles`/`permissions`/
  `role_permissions` (shared structural taxonomy, not per-agency data —
  per-org custom roles would be a separate, unrequested feature) and
  `user_permissions` (org derivable via `user_profiles.user_id`, existing
  RLS already restricts to the owning user or an admin). Three tables named
  in the original request don't exist in this codebase and were skipped,
  not guessed at: `team_members` (client-portal "Team Members" are
  `client_memberships`/`user_profiles` rows, already covered),
  `invites` (logins are created directly via `admin.auth.admin.createUser`,
  no invite table), and `funding_platforms`/`usd_purchases`/
  `usd_treasury_ledger` (a still-unbuilt, design-stage USD-purchase-tracking
  feature — `usd_purchases` briefly existed but was dropped in the finance
  rebuild, see the Finance entries above; none of the three exist today).
  `organization_id` is `NOT NULL` with a **DB-level DEFAULT of org zero's
  id** (a fixed literal — Postgres doesn't allow subqueries in DEFAULT
  expressions) rather than the nullable→backfill→NOT NULL three-step
  originally specified: a constant DEFAULT lets Postgres add the column,
  backfill every existing row, and enforce NOT NULL in one fast
  metadata-only statement (no table rewrite), and every current insert path
  (none of which sets `organization_id` yet) keeps working unchanged. This
  default is a **temporary safety net** — see Phase 1B below for why it's
  necessary and what removes it.
  New `user_profiles.is_platform_admin boolean` (cross-org access) —
  granted to `mehedi.h.prantoz@gmail.com` (confirmed live: existing account,
  already this org's `SUPER_ADMIN`-role user). **Deliberately not named
  `is_super_admin`**: this app already has a per-organization `SUPER_ADMIN`
  *role* (`roles.key`, checked by `is_admin()`/`has_permission()`) — that
  role stays subject to its own org's subscription gate; the new flag is a
  different, cross-org concept (bypasses the gate entirely, sees every
  organization). Reusing the name risked exactly the kind of collision this
  codebase's history has been bitten by before (Remaining vs. Current
  Balance, Employees vs. Team Members) — flagged to the owner before
  building, who agreed on the distinct name.
  Three new RLS helper functions matching the existing
  `is_admin()`/`is_client_member()`/`has_permission()` style exactly
  (`SECURITY DEFINER`, `stable`): `current_org_id()`, `is_org_active(org_id)`,
  `is_platform_admin()`. Every existing SELECT policy on the 17 tables
  above updated via `ALTER POLICY ... USING (...)` (preserves policy
  name/history over drop+recreate): wraps the original condition with
  `organization_id = current_org_id() and is_org_active(organization_id)`,
  OR'd with an `is_platform_admin()` bypass. `organizations` itself gets
  RLS enabled with **zero policies for `authenticated`** — same treatment
  as `app_settings`: cross-tenant subscription data, reachable only through
  the service-role server layer (the future super-admin panel), never
  queried directly from a browser session. No automatic down-migration
  (Supabase's tooling doesn't support one, and none of the prior 30
  migrations in this repo use one) — a manual rollback path is documented
  as a comment block at the top of the migration file instead.
  **Critical finding surfaced before writing any SQL, which is why this
  became 4 phases instead of 3**: RLS in this app is defense-in-depth only,
  never the primary authorization layer — per this file's own "Security
  rules" section, virtually all business reads/writes go through
  `src/server/**/*.fns.ts` (23 files, confirmed) using the service-role
  key, which **bypasses RLS entirely**. So this migration alone does not
  isolate two simultaneously-*active* organizations in the running app —
  every query inside those 23 files still needs `organization_id`
  filtering/tagging by hand. Flagged to the owner via AskUserQuestion before
  proceeding rather than silently shipping a false sense of isolation; they
  chose to fold this in as an explicit **Phase 1B: server-layer org
  scoping** (not started yet) ahead of Phase 2 (super-admin panel) and
  Phase 3 (subscription-gate enforcement) from the original request. Until
  Phase 1B lands, the DEFAULT-to-org-zero safety net above matters: it's
  what keeps org zero's existing behavior from regressing the moment this
  migration is applied, but it also means a second org's write that forgets
  to set `organization_id` would silently land in org zero's data —
  acceptable only because the owner provisions subscriptions manually and
  controls exactly when a second organization goes live.
  Vitest: 48/49 pass after this migration was added (no app code touched
  yet, so no change expected) — the 1 failure (`permissions.test.ts`,
  expects an exact 4-entry `SENSITIVE_PERMISSIONS` list) is **pre-existing**,
  confirmed via `git log` to predate this session: `finance.view`/
  `finance.manage` were added as sensitive permissions when Finance shipped
  (commit `0e3e8fe`) and this test's hardcoded expectation was never
  updated. Unrelated to this work, flagged not fixed (out of scope here).
  **Owner must apply this migration via the SQL editor or `supabase db
  push`** — no DB connection, `supabase` CLI, or `DATABASE_URL` is available
  in this dev environment to apply it directly (read-only access via the
  service-role key was used beforehand to confirm the target platform-admin
  account exists and that `organizations` doesn't already exist).
- **Multi-tenant subscription conversion — Phase 1B (server-layer org
  scoping): done, pending owner review. Confirmed applied to the live
  project** (same `supabase db push` as Phase 1 above; verified directly —
  `total_outstanding_due`/`all_client_dues` callable with
  `p_organization_id`, old zero-arg/unscoped signatures correctly gone
  from the schema cache). Before reconciling the Supabase CLI's migration
  history (see below), `approve_payment`'s live signature was directly
  probed (a safe call with a bogus id) and confirmed to already be the
  3-arg `(payment_id, actor, amount_bdt)` form from migration 000024,
  rather than assumed — avoiding mismarking a migration as applied when it
  might not have been. Closes the gap Phase 1 flagged: since RLS never runs in
  normal app usage (everything goes through the service-role admin client),
  the actual isolation work is here — every read/write in the 23
  `src/server/**/*.fns.ts` files plus their supporting `.service.ts`/
  `.server.ts` modules, now filtering by `organization_id` on reads,
  tagging it on inserts, and validating it before any update/delete that
  targets a row by id.
  Foundation: `SessionUser` (`src/lib/auth/types.ts`) gained
  `organizationId: string` and `isPlatformAdmin: boolean`, populated in
  `loadSessionUser()` (`auth.fns.ts`) from the same `user_profiles` row
  already being read — every `requireAdmin()`/`requireClientMembership()`/
  `requireUser()` caller gets these for free, no guard changes needed.
  New migration `20260723000032_multi_tenant_rpc_scoping.sql`: 9 RPCs that
  look up an existing row by id (`assign_ad_account`, `release_ad_account`,
  `transfer_ad_account`, `create_adjustment`, `reverse_financial_transaction`,
  `approve_limit_request`, `rebase_limit_request`, `approve_payment`,
  `submit_payment`) gained a `p_organization_id` parameter, validated
  against the looked-up row before acting (an IDOR guard — without it, one
  organization's admin could act on another's data by id once a second org
  exists) and used to tag any new rows inserted; `client_financials(p_client_id)`
  deliberately untouched — every caller now validates the client_id belongs
  to their own org before calling it, so the function itself doesn't need
  the param. 4 bulk aggregate RPCs (`total_outstanding_due`,
  `all_client_dues`, `admin_today_totals`, `top_due_clients`) gained the
  same parameter and an internal `WHERE organization_id = ...` filter —
  these scan across ALL clients with no per-row check otherwise, so without
  this every admin dashboard/report would have silently mixed every
  organization's totals together.
  **Two critical bugs found and fixed, not just theorized** while doing
  this pass:
  1. `notifyAdmins()` (`notification.service.ts`) fanned out to every
     ACTIVE admin/super-admin across **every** organization with zero
     filter — any client's limit-request/payment submission would have
     notified every other subscribing agency's admins too. Fixed:
     `adminUserIds()` now takes `organizationId`; `notifyAdmins()` requires
     it explicitly (no client/account context to derive it from).
     `notifyClientMembers(clientId, ...)` needed no call-site changes at
     all — it now resolves `organization_id` from the `clients` row itself
     (clientId already uniquely determines it), so its 8 existing call
     sites across `assignment.fns.ts`/`limit-request.fns.ts`/
     `payment.fns.ts`/`payment-request.fns.ts` stayed untouched.
  2. `resetAllDataFn` (`maintenance.fns.ts`, Settings → Danger Zone "Clear
     all data") had a **second, independent implementation** of the same
     catastrophic bug already fixed in the `reset_all_data()` RPC: a JS
     fallback path (`directWipe()`, used whenever the RPC isn't installed —
     which is true right now, since this migration isn't applied yet) that
     deleted **every row in every table via `.neq('id', NIL_UUID)`, with
     no organization filter at all**, and a storage-bucket cleanup
     (`emptyBucket()`) that recursively removed **every file in the entire
     shared `proofs` bucket**, not just the caller's own. In a multi-tenant
     world, any org's own admin clicking "Clear all data" — the ONLY
     working path today, since the RPC isn't live yet — would have wiped
     every other subscribing agency's data and every other agency's proof
     files. Fixed: `directWipe()` now takes `organizationId` and scopes
     every delete to it; storage cleanup rewritten as
     `removeOrgProofFiles()`, which captures the caller's own
     `attachments.storage_path` values (scoped by `organization_id`)
     **before** any rows are deleted, then removes only those specific
     paths from the bucket. Also fixed, found incidentally in the same
     function: `WIPE_ORDER` (the fallback's table list) had silently
     drifted out of sync with the RPC — missing `employees`/
     `client_employees` (added when the RPC's own "now clears employees
     too" fix shipped, but never back-ported to this fallback) — now
     matches. Document-code sequences (`client_code_seq`, etc.) are shared
     across every organization, so neither path resets them anymore
     (correct — resetting a shared counter because one org cleared their
     own data would renumber/collide codes for every other still-live
     org); `resetAllDataFn`'s `countersReset` field is now always `false`,
     kept in the response shape only so the existing two-message toast
     copy in `reset-data-dialog.tsx` still renders correctly without a UI
     change.
  **One earlier decision reversed, with reasoning**: Phase 1's entry above
  says `app_settings` (Meta integration credentials) would be "scoped
  per-organization now." Investigating the actual runtime consumer changed
  that: `getMetaConfig()` (`meta.server.ts`) takes **zero parameters** and
  is called from many places including the daily cron with no signed-in
  session at all — making it org-aware would mean threading an
  `organizationId` through every call site of `fetchMetaAdAccount()`/
  `listMetaBusinessAdAccounts()`/`updateMetaAdAccountSpendCap()` across
  `meta.fns.ts`, `meta-sync.server.ts`, and `spend-cap-sync.server.ts` — a
  materially bigger, separate redesign of how the Meta integration works,
  not "add an org filter to an existing query." Doing only half of it
  (letting the Settings screen save a per-org token while the runtime
  still only ever reads org zero's) would have been actively misleading —
  it would look like it worked and silently not. `app_settings`/
  `settings.fns.ts` are left single-tenant (org-zero-only) for this pass;
  `getMetaConfig()`, `syncMetaAdAccounts()`'s digest notification (still
  one shared Business Portfolio scanned with no per-org grouping), and the
  Meta integration generally are flagged as not multi-tenant-aware yet —
  tracked as a dedicated follow-up, out of scope for "add organization_id
  to existing queries." Per-account Meta actions inside this scope (name
  sync, spend-cap push/apply, spend-cap auto-sync-on-approval) ARE
  correctly org-validated in this pass, since each already operates on one
  specific, already-org-checked `ad_accounts` row — only the
  portfolio-wide cron digest and the credentials themselves stay deferred.
  **SUPERSEDED 2026-09-14** — that deferral is closed: see "Meta integration
  is now per-organization" below. `app_settings` is keyed by
  `(organization_id, key)`, `getMetaConfig()` takes an organization id, and
  the cron iterates agencies. Don't act on this paragraph's "left
  single-tenant" statement; it describes the state before that pass.
  Also found and fixed while auditing `meta.fns.ts`: `importMetaAdAccountsFn`
  wasn't setting `organization_id` on newly-created `ad_accounts` rows at
  all (would have silently defaulted every import, from any org, to org
  zero); `loadUsdLinkedAccount()` (shared by `applyMetaSpendCapFn`/
  `updateMetaSpendCapFn`) had no org check on the account it loads.
  `provisionClientLogin()` (`client-login.server.ts`, shared by the
  admin's "Add login" and the portal's self-service "Add teammate") also
  needed a new `organization_id` parameter for two reasons: (1) a brand
  new auth user's `user_profiles` row defaults to org zero via the
  `handle_new_user()` trigger, which has no way to know the real target
  org, so it must be corrected explicitly; (2) reusing an existing
  CLIENT-role login (the "one login, several clients" path) now refuses
  the reuse if that login already belongs to a **different** organization
  — a person who happens to be a client of one subscribing agency should
  never be silently linkable into a different agency's roster by sharing
  an email, which the original cross-org-blind implementation would have
  allowed.
  `writeAudit()` (`audit.service.ts`) gained a required `organizationId`
  field (`audit_logs.organization_id` is `NOT NULL`) — 40 call sites
  across 14 files needed it; 37 followed the identical
  `actorUserId: actor.id,`/`actorUserId: user.id,` pattern and were
  updated via a small script (verified by diff, not blindly trusted); the
  3 system/cron call sites with no signed-in actor
  (`syncAdAccountName`/`syncAndPersistAdAccountSpendCap`'s audit writes)
  were fixed by hand, threading the affected `ad_accounts` row's own
  `organization_id` through instead — correctly per-account even though
  the cron itself isn't yet org-aware overall.
  `npm run typecheck` / `npm run build`: clean. `npm test`: 48/49, same
  single pre-existing failure as Phase 1 (unrelated, confirmed again via
  `git log`). Two small type-only fixes needed along the way:
  `src/lib/auth/types.test.ts`'s `SessionUser` test fixture updated for
  the two new required fields; two `user.fns.ts` casts switched to
  `as unknown as` (this codebase's existing convention for a
  Supabase-join-shape mismatch) after adding a null-narrowing check
  changed how strictly TypeScript compared the cast.
  **Owner must apply `20260723000032_multi_tenant_rpc_scoping.sql`**
  (alongside `20260723000031` from Phase 1, if not already applied) via
  the SQL editor or `supabase db push` — same no-DB-connection constraint
  as every other pending migration in this project.
- **Multi-tenant subscription conversion — Phase 2 (super-admin panel) +
  Phase 3 (live subscription gate): done, pending owner review, no new
  migration** (both phases build entirely on the `organizations` table +
  `is_platform_admin` flag from Phase 1). Verified live in a real browser
  against the production database — not just typecheck/build — using the
  same temporary Playwright + magic-link session technique documented
  elsewhere in this file, installed and removed again after (confirmed
  zero `package.json`/lockfile diff).
  **Phase 2**: new `/admin/organizations` route, gated to
  `user.isPlatformAdmin` only (redirects everyone else to `/admin`) — a
  new `requirePlatformAdmin()` guard in `guards.server.ts`, distinct from
  `requireAdmin()`, since this is the one place in the app that
  deliberately sees and edits across every organization rather than just
  the caller's own. `src/server/organizations/organization.fns.ts`:
  `listOrganizationsFn` (all orgs, client-side search/filter — the list is
  manually curated and small by design), `updateOrganizationFn`
  (name/plan/notes — mirrors `updateClientFn`), and
  `updateOrganizationSubscriptionStatusFn` (the activate/suspend toggle,
  stamps/clears `suspended_at` — mirrors `setClientStatusFn`'s separate-
  from-general-edit pattern). Both writes audited
  (`ORGANIZATION_UPDATED` / `ORGANIZATION_SUBSCRIPTION_STATUS_CHANGED`).
  `updateOrganizationSubscriptionStatusFn` refuses to let a platform admin
  suspend their OWN organization — they'd personally still bypass the
  gate either way, but every other real user in that org would be locked
  out; a realistic one-click mistake worth blocking outright rather than
  just documenting. UI: `EditOrganizationDialog`
  (`src/components/admin/organizations/`) follows the employee dialog's
  exact RHF+Zod pattern; the list page reuses `StatusBadge` directly (no
  new variant needed — `ACTIVE`/`SUSPENDED`/`CANCELLED` were already
  defined with the right emerald/amber/zinc colors, DB values just
  uppercased at the display call site since they're stored lowercase).
  "Organizations" added to `ADMIN_NAV` behind a new `platformAdminOnly`
  flag on `NavItem`, filtered out in `admin/route.tsx` for everyone else
  (an unfiltered nav array has no other gating mechanism in this app, so
  this is a new, minimal field, not a new pattern).
  **Real bug found and fixed during live verification**: org zero's
  hand-picked sentinel id (`00000000-0000-0000-0000-000000000001`, chosen
  in the Phase 1 migration) is not a real RFC 4122 UUID — its version
  nibble is `0`, not `1`–`8` — so Zod v4's strict `z.uuid()` rejected it
  outright the moment it was submitted as form input (`Invalid UUID`),
  which would have permanently blocked editing or toggling org zero
  specifically (any *other* organization, with a real
  `gen_random_uuid()`-generated id, would have been fine). Fixed with a
  shape-only regex validator (`src/schemas/organization.ts`) for
  organization ids specifically, accepting the general 8-4-4-4-12 hex
  grouping without enforcing the version/variant nibbles — every other
  `z.uuid()` usage in the app is untouched, since every other entity's id
  is a real `gen_random_uuid()` value.
  **Phase 3**: `SessionUser` gained `organizationSubscriptionStatus`,
  fetched fresh on every session load (`auth.fns.ts`'s `loadSessionUser()`)
  via the service-role client specifically — `organizations` has zero RLS
  policies for `authenticated` (Phase 1's design), so even a user's own
  org row isn't reachable through the RLS-scoped client `loadSessionUser`
  otherwise uses. Two enforcement layers, matching this app's own stated
  architecture (route guards are UX only; server fns are the real
  boundary): (1) `guards.server.ts`'s shared `loadUserOrThrow()` — the
  function every `requireUser()`/`requireAdmin()`/`requireClientMembership()`
  call already goes through — now throws a new `AuthError` code
  (`SUBSCRIPTION_SUSPENDED`) when `!user.isPlatformAdmin &&
  organizationSubscriptionStatus !== 'active'`, so flipping the toggle
  blocks every protected server fn immediately, not on next login;
  `requirePlatformAdmin()` deliberately does NOT go through this check,
  by design ("Super admins bypass this check entirely" applies everywhere,
  not just on the organizations panel's own route). (2) `admin/route.tsx`
  and `portal/route.tsx`'s `beforeLoad` — the same UX-redirect pattern
  both already use for role mismatches — redirect to
  `/subscription-suspended` under the identical condition, so a suspended
  org's user gets a clear page instead of a wall of failed-request toasts.
  New `/subscription-suspended` route: authenticated-only (redirects to
  `/login` with no session), and — the inverse case — redirects an
  active-org or platform-admin user who somehow lands here straight back
  to their normal home, rather than showing a page that doesn't apply to
  them. Loads no app data at all (only calls `logoutFn`). Message names
  "xRush Agency" (org zero) as the contact, matching the "[agency name]"
  the owner's original request specified — this is the SaaS vendor to
  contact, not the suspended org's own name.
  **Live verification, both phases together, against the real production
  database** (org zero is the only real organization, `active` today —
  every check below had to be done without ever actually leaving it
  suspended): logged in as the real platform-admin account via the
  established magic-link session-injection technique; confirmed the
  dashboard loads with zero regression (proving the new per-session
  organization-status query doesn't break existing sessions);
  `/admin/organizations` renders correctly, "Organizations" appears in
  the nav for the platform admin; the self-suspend guard was exercised
  for real (clicking "Suspend" on org zero) and correctly blocked with
  the exact error message, confirmed via a direct DB read that
  `subscription_status` never changed and — critically — that no
  `ORGANIZATION_SUBSCRIPTION_STATUS_CHANGED` audit row was written for
  the blocked attempt (the guard throws before the audit call is ever
  reached); the edit dialog was round-tripped for real (set `plan` to a
  test value, saved, reverted to blank, saved again), confirmed via a
  direct DB read that the final state exactly matches the original
  (`plan: null`) and via the `audit_logs` table that both
  `ORGANIZATION_UPDATED` rows are present with the correct old/new
  values in the correct order. Zero browser console errors throughout.
  `npm run typecheck` / `npm run build`: clean. `npm test`: 48/49, same
  single pre-existing failure as every other pass today (confirmed
  unrelated again).
  All 4 phases of the multi-tenant subscription conversion are now done,
  pending the owner's final review.
- **CRITICAL FIX — a suspended organization's users could never reach
  `/subscription-suspended`: migration `20260723000033`, confirmed applied
  to the live project.** Found by a post-implementation review pass that
  tested the one path Phase 3's own verification had missed: an *actually
  suspended* organization (the earlier pass only proved an *active* org
  isn't blocked). Created a throwaway organization + user, suspended it,
  and requested `/portal` — it redirected to **`/login`**, not
  `/subscription-suspended`.
  **Root cause**: `20260723000031`'s `user_profiles_select` RLS policy
  gates every row — including the caller's own — on
  `is_org_active(organization_id)`. But `loadSessionUser()` (`auth.fns.ts`)
  reads exactly that row, through the RLS-scoped client, to build
  `SessionUser` at all. Suspended org → own profile row invisible →
  `loadSessionUser()` returns null → `context.user` is null → the route
  guards read that as "not signed in" and bounce to `/login`;
  `/subscription-suspended` did the same (it requires a session too), and
  logging back in failed with "This account is inactive or not fully
  provisioned" (same `loadSessionUser()` call). Net effect: a suspended
  organization's users were indistinguishable from logged-out ones, and
  the entire Phase 3 page was unreachable dead code for the exact case it
  exists for. **This interaction was actually predicted in writing during
  Phase 1** ("if the user's org is SUSPENDED... it would look exactly like
  'invalid session/logged out'") and then not carried through into Phase
  3 — a flagged risk that was never closed, which is why the review pass
  tested it specifically.
  **Fix**: the caller's own row is now always readable regardless of
  subscription status (it is their own identity row — no tenant isolation
  is lost); reading *other* users' rows still requires both an
  organization match and an active subscription, exactly as before. The
  gate itself is untouched — it lives in `guards.server.ts` and the route
  guards, never in hiding a user's identity from themselves.
  **Verified end-to-end after the fix**, against a real suspended
  organization: own profile readable again; CLIENT-role user at `/portal`
  → `/subscription-suspended`; ADMIN-role user at `/admin` →
  `/subscription-suspended`; `/admin/organizations` → likewise; the
  suspended page itself renders with the right copy ("Subscription
  inactive" / "Contact xRush Agency to reactivate access." / "Sign out").
  The server-side layer (`loadUserOrThrow()`'s `SUBSCRIPTION_SUSPENDED`
  throw) is verified by inspection plus the empirically-confirmed fact
  that `organizationSubscriptionStatus` is correctly `'suspended'` for
  that user — it is the same field, read from the same
  `getCurrentUserFn()` call, that made the route redirect fire. Throwaway
  organization and user were both deleted afterward; confirmed org zero is
  the only remaining organization, still `active`, with no orphaned
  profiles.
  Also hardened while there: `loadSessionUser()`'s organization lookup now
  logs its error explicitly. `organization_id` is a NOT NULL FK, so the
  row always exists — a null result means the *query* failed, and the
  behavior is deliberately fail-closed (treated as suspended), which means
  a transient DB blip would bounce an entire organization to
  `/subscription-suspended`. Logged loudly so that reads as an outage
  rather than a subscription problem. **Flagged, not changed**: whether
  fail-closed is the right tradeoff there is the owner's call.

### Phase 8 conventions
- Tests run via Vitest with a **standalone `vitest.config.ts`** that does NOT
  load the TanStack Start / Nitro plugins (pure unit tests only); `@` alias is
  resolved with `fileURLToPath` (a bare URL `.pathname` breaks on Windows).
  Test files are `src/**/*.test.ts`. Scripts: `npm test`, `npm run test:watch`.
- Only DB-independent logic is unit-tested; DB-enforced rules (limit/payment
  approval, transfer, adjustment/reversal, stale-baseline, duplicate-approval,
  concurrency) live in PostgreSQL RPCs and are covered by the procedures + SQL
  reconciliation queries in `docs/TESTING.md` (run against a live project).
- Pure ledger running-balance was extracted to `src/lib/ledger/running-balance.ts`
  (imported by `ledger.fns.ts`) so it is testable without pulling server-only
  modules — keep that split.
- Deployment: Nitro auto-selects the `vercel` preset when `VERCEL` is set at
  build; no `vercel.json` needed. Required env: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only, never
  `VITE_`-prefixed).
- **All 8 phases are complete.** The product is feature-complete and hardened,
  pending the owner's final review + production deploy.

### Phase 7 conventions
- Notifications are in-app only (spec §54, no external providers).
  `notification.service.ts` mirrors `writeAudit`: best-effort, fired AFTER the
  primary transaction (never blocks/rolls back), one row per recipient.
  `notifyAdmins()` fans out to all ACTIVE admins; `notifyClientMembers(clientId)`
  to a client's ACTIVE members. For the atomic RPCs (approve limit/payment,
  assign/release/transfer) the notification is fired from the fn wrapper after
  the RPC returns; release/transfer capture the losing client id BEFORE the RPC
  clears the active assignment.
- `notifications` has a SELECT-only RLS policy (`user_id = auth.uid()`);
  mark-as-read is a write and goes through the server layer like everything else.
- Reports and search are read-only, `reports.view` / admin-guarded. CSV export
  is client-side (`src/lib/csv/csv.ts`, UTF-8 BOM so Excel renders ৳) — no new
  deps, no server round-trip. `all_client_dues()` is the only new RPC (Client
  Due Report); every other report is a plain filtered query.
- Global search (`globalSearchFn`) is server-side (spec §72), matches clients,
  ad accounts (incl. external id), and the LR/PAY/PR document numbers; the
  header search box (admin only) navigates to `/admin/search?q=`.

### Phase 5 conventions
- Only `approve_payment` (service_role RPC, row-locked) writes the PAYMENT
  ledger credit; pending/rejected/cancelled payments never touch the ledger.
  It also advances a linked payment request to PARTIALLY_PAID / PAID.
- Payment proof is submitted inline with the payment (`submitPaymentFn` takes
  base64) so a payment can never exist without proof; on storage/attachment
  failure the payment row is rolled back. Reuses the `proofs` bucket under
  `payments/{paymentId}/`.
- Overpayment guard (spec §49) is server-side: amount ≤ current_due − pending
  payments total. Admin approval can still exceed it (admin override).

### Phase 4 conventions
- Due is never a stored column — always derived from `ledger_entries` via the
  `client_financials(client_id)` SQL function (spec §35). `total_outstanding_due()`
  aggregates across all clients for the admin dashboard.
- Corrections only ADD ledger rows, never edit/delete: `create_adjustment`
  (one adjustment row + one ledger row) and `reverse_financial_transaction`
  (opposite ledger row + adjustment row, duplicate-reversal guarded). Both are
  service_role-only RPCs. `adjustments.create` is sensitive (SUPER_ADMIN only
  by default); `adjustments.view`/`ledger.view` are default admin perms.
- Running balance is computed server-side in `ledger.fns.ts` (decimal.js),
  not stored (no mutable `balance_after`).

### Phase 3 conventions
- The `ledger_entries` table exists as of Phase 3 because approval must write
  the LIMIT_APPROVAL debit atomically inside `approve_limit_request`. The
  ledger *UI*, statement, adjustments and reversals are Phase 4.
- Proof files: private `proofs` Supabase Storage bucket. Upload goes through
  `uploadLimitProofFn` as base64 JSON (≤3 MB, jpg/png/webp/pdf) — chosen over
  direct browser→storage upload to keep all writes server-side. Downloads use
  short-lived signed URLs (`signProofUrl`, 60s). Never make the bucket public.
  **Superseded 2026-08-23**: this proof was always the *admin's* own evidence
  (`uploadLimitProofFn` is `requireAdmin`-gated — the client never provides
  one), almost certainly a screenshot of manually updating Meta's spend cap
  before approving. No longer mandatory now that "Auto-push approved limit
  increases to Meta spend_cap" does that automatically — see the post-Phase-8
  entry below. `uploadLimitProofFn`/`proofUploadSchema` still exist (unused)
  in case a future need for admin-attached proof comes back.
- Approval RPC re-checks the stale baseline (`opening_balance_usd` vs live
  `current_limit_usd`) and raises `STALE_BASELINE: …`; the UI also shows the
  banner proactively from `getLimitRequestDetailFn`. Rebase via
  `rebase_limit_request`.
- **USD rate resolution (superseded twice — read this, not the spec's §27
  global-rate model):** the rate for a limit request comes from
  `adAccountUsdRate(accountId, clientId)` in `rate.service.ts` —
  `ad_accounts.usd_rate` wins, falling back to `clients.usd_rate` when it is 0
  (migration `…0010`). Client-level USD conversions (current due, dashboard
  totals) stay on `clientUsdRate` because they aggregate across accounts. The
  global `exchange_rates` table is retained for history only. Approvals still
  snapshot the applied rate immutably. `exchange_rate.manage` is a sensitive
  permission (SUPER_ADMIN only by default).

### Phase 2 conventions
- Server fns live in `src/server/{clients,ad-accounts}/*.fns.ts`; shared Zod
  form schemas in `src/schemas/`; domain TS types in `src/types/domain.ts`.
- Multi-write operations (assign/release/transfer) are PostgreSQL RPCs
  (`assign_ad_account`, `release_ad_account`, `transfer_ad_account`) —
  SECURITY DEFINER, row-locked, audit inside the txn, execute granted to
  `service_role` only. Simple single-row CRUD writes go through the admin
  client with a best-effort `writeAudit()` after.
- NUMERIC columns come back from supabase-js as **strings** — types reflect
  this (`current_limit_usd: string`); format with `src/lib/money`.
- Human-readable codes (`CL-000N`, `ADA-000N`) are DB sequence defaults; the
  server never sets them. Internal id stays UUID.

## Stack (verified versions — do not downgrade or swap)

- TanStack Start `1.168.x` as a **Vite plugin** (`vite.config.ts`; there is no
  `app.config.ts` / vinxi — that convention is outdated).
- TanStack Router 1.170.x, file-based routes in `src/routes`, route tree
  regenerated by dev/build or `npm run generate-routes`.
- Vite 8, Nitro **v3** via `nitro/vite` plugin. Deployment: Vercel serverless —
  Nitro auto-selects the `vercel` preset when the `VERCEL` env var is present
  at build (no extra config needed); local builds use `node-server`.
- React 19, TypeScript strict, Tailwind v4 (CSS-first config in
  `src/styles.css`), shadcn/ui (`npx shadcn add <component>`), Lucide icons.
- Supabase (`@supabase/supabase-js` + `@supabase/ssr`), Zod v4
  (`z.email()`, `z.url()` — not `z.string().email()`), React Hook Form +
  `@hookform/resolvers`, decimal.js for money math.

## Framework conventions that bit us already

- **Import protection is enforced at build**: client-reachable code must never
  import `**/*.server.*` files, and server-reachable code must never import
  `**/*.client.*` files. Hence the naming scheme:
  - `*.fns.ts` — server function endpoints (`createServerFn`); safe to import
    from routes/components (handlers are compiled out of the client bundle).
  - `*.server.ts` — truly server-only modules (service-role client, guards);
    only import from other server-only modules or inside server fn handlers.
  - Public env lives in `env.public.ts` (not `.client.ts`) because SSR also
    reads it.
- `createServerFn().validator(schema)` — `.inputValidator()` is deprecated.
- Server request helpers (`getCookies`, `setCookie`, `getRequestUrl`, …) come
  from `@tanstack/react-start/server`.
- The root route's `beforeLoad` loads the session (`getCurrentUserFn`) into
  router context as `context.user`; layout guards in `src/routes/agency/route.tsx`
  and `src/routes/client/route.tsx` consume it. **The three areas are `/platform`
  (vendor), `/agency` (one agency's own data) and `/client` (one client's own
  data)** — renamed from `/admin` and `/portal` on 2026-09-15; entries dated
  before that in the log below name the old paths and were deliberately left as
  written. Real path prefixes are used instead of the spec's pathless
  `_admin`/`_client` because both defined a colliding `/dashboard` path.

## Security rules (non-negotiable, spec §5, §58–60)

- Browser Supabase client (`src/lib/supabase/client.ts`) is for auth/session
  flows ONLY. All business reads/writes go through server functions.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only; never `VITE_`-prefixed, never
  imported into client-reachable code (`admin.server.ts` is wrapped in
  `createServerOnlyFn`).
- Every business server function must call a guard from
  `src/server/auth/guards.server.ts` (`requireUser` / `requireAdmin` /
  `requireClientMembership`) before doing work. Route guards are UX only.
- RLS: SELECT-only policies for `authenticated`; no write policies — writes go
  through the server layer with the service-role key after authorization.
  Keep it that way for new tables.
- Financial math: PostgreSQL NUMERIC + RPC transactions are authoritative;
  server-side recalculation uses decimal.js (`src/lib/money`). Never trust
  frontend-computed amounts. Approved financial records are immutable —
  corrections via adjustment/reversal only.

## Commands

- `npm run dev` — dev server on :3000 (needs `.env`; placeholder values exist)
- `npm run typecheck` / `npm run build` / `npm run generate-routes`
- DB: apply `supabase/migrations/*.sql` via Supabase CLI (`supabase db push`,
  no local install needed — `npx supabase <command>` works, needs
  `SUPABASE_ACCESS_TOKEN` since this environment has no browser for
  `supabase login`) or the SQL editor; `supabase/seed.sql` has commented
  dev helpers (promote a user to SUPER_ADMIN, create a dev client/
  membership). **As of 2026-09-14, the CLI's remote migration-history
  bookkeeping is reconciled with reality** (`supabase migration repair
  --status applied 20260723000001 ... 20260723000030`, run once after
  discovering every earlier migration had been applied by hand via the SQL
  editor and the CLI had no record of any of them) — `supabase db push`
  can be used directly for new migrations going forward without repeating
  that reconciliation, as long as every future migration is applied
  through the CLI (or the CLI's history is repaired again if one is ever
  applied by hand instead).

## Windows note

Do not round-trip source files through PowerShell 5.1 `Get-Content`/
`Set-Content` — it mis-decodes UTF-8 without BOM and corrupts `§`/`—` chars.
Use the Edit/Write tools or Node scripts instead.
