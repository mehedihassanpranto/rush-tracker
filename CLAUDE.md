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
  request for one `ad_account_id`, chronological, across every client that
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
  `LIMIT_REQUESTS_VIEW`) mirrors the ad account Usage tab's fn but flipped:
  every **APPROVED** request for one `client_id` across every ad account
  they've ever held, most-recent-approval-first (Usage sorts ascending
  since it's a running trail to the current limit; this is a plain activity
  feed, matching the Adjustments tab's newest-first convention). Columns:
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
  full before/after. **Owner must apply this migration via the SQL editor
  or `supabase db push`** — no DB connection is available in this dev
  environment to apply it directly.

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
  router context as `context.user`; layout guards in `src/routes/admin/route.tsx`
  and `src/routes/portal/route.tsx` consume it. Path prefixes `/admin` and
  `/portal` are used instead of the spec's pathless `_admin`/`_client`
  because both defined a colliding `/dashboard` path.

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
- DB: apply `supabase/migrations/*.sql` via Supabase CLI (`supabase db push`)
  or the SQL editor; `supabase/seed.sql` has commented dev helpers (promote
  a user to SUPER_ADMIN, create a dev client/membership).

## Windows note

Do not round-trip source files through PowerShell 5.1 `Get-Content`/
`Set-Content` — it mis-decodes UTF-8 without BOM and corrupts `§`/`—` chars.
Use the Edit/Write tools or Node scripts instead.
