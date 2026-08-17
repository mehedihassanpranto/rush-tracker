# Rush Tracker — Agent Instructions

**Read `docs/PROJECT_SPEC.md` before implementing or changing anything.** It is
the source of truth for business rules, financial logic, and security
boundaries. If code conflicts with the spec, the spec wins. Note: the tail of
the spec copy (after §85) was truncated in transfer — ask the owner for the
full document if you need the testing/later sections.

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
    live data before adding it, so it applies cleanly. **This migration is
    not yet applied to the live project — apply via `supabase db push` or
    the SQL editor before the fix takes effect at the DB level.**
  - Duplicated USD/linked-account guard logic between `applyMetaSpendCapFn`
    and `updateMetaSpendCapFn` extracted into a shared `loadUsdLinkedAccount()`.
  - **Left open, not fixed**: whether `spend_cap` writes are really in
    dollars (as documented/implemented) or cents (as one review pass
    suspected) was never empirically confirmed — a live test write was
    blocked by Claude Code's safety classifier. Research (Meta's official
    docs page + a corroborating web search + the official Python SDK typing
    `spend_cap` as `float` in write params) favors "dollars" 3-to-1, but
    this has NOT been proven by an actual write-and-read-back. **Do not
    rely on `updateMetaSpendCapFn` for a real financial decision until
    someone runs that test** (see the conversation this session for the
    exact curl command against a safe $0-spend test account).
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
  - **Left open, needs an owner decision, not done**: whether any
    Meta-sourced data (specifically "Remaining" — the client's own spend
    headroom before Meta pauses their ads) should ever reach the client
    portal. Every Meta fn today requires `AD_ACCOUNTS_MANAGE`
    (`requireAdmin`), by design — spec §9 doesn't ask for it, and none of
    the existing Meta server fns are client-safe (no `requireClientMembership`
    path, no scoping to "only this client's own account"). If this is ever
    wanted, it needs new client-scoped fns, not reuse of the admin ones.
  - **Also identified, not yet built**: profile editing is still a hardcoded
    "later phase" stub in `portal/profile/index.tsx` (the one spec §9
    capability with zero implementation), and the client ad-accounts table
    folds spec §67's "Pending Request" column into the action button's
    label instead of a separate column.

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
