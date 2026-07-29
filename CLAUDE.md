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
