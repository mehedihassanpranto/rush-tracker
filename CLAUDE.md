# Rush Tracker — Agent Instructions

Rush Tracker is a multi-tenant SaaS for Meta-ads agencies: ad-account limits,
a client ledger (dues in BDT, limits in USD), payments, and a vendor platform
that sells it to agencies and lends them ad accounts from a central pool.
Production: `https://panel.xrush.online` (Hostinger). The first agency is
xRush Agency.

**Read `docs/PROJECT_SPEC.md` before implementing or changing anything.** It is
the source of truth for business rules, financial logic, and security
boundaries. If code conflicts with the spec, the spec wins — except where this
file records a later, owner-approved change (e.g. USD-rate resolution below).
The spec copy is truncated after §85; ask the owner for the rest if needed.

**`docs/HISTORY.md`** is the full feature-by-feature build log (moved out of
this file 2026-10-03). Read the relevant entry before changing a feature — it
holds the reasoning, the verified facts, and the mistakes already made once.
It's frozen; don't add to it.

## Changelog convention

**`CHANGELOG.md` (repo root) gets a dated entry for every day changes are
made** — newest day at the top, grouped by feature/area, not a file list. Add
to today's section when you finish a piece of work. When a change creates a
lasting rule or trap, also add ONE line to the rules below — keep this file
short; detail belongs in the changelog.

## Working agreements

- **Commit and push the same day.** `main` is protected: branch, open a PR, and
  merge only when CI (`.github/workflows/ci.yml`: typecheck, build, unit + live
  tests, Playwright e2e on staging) is green.
- **The merge is the deploy** — Hostinger pulls `main` and rebuilds. A migration
  the new code depends on must be applied to production BEFORE merging.
- **Never run destructive checks against production.** Live-DB tests and e2e
  target the staging project only (`.env.test`, `docs/STAGING.md`);
  `src/test/live-env.ts` and `e2e/support/env.ts` refuse production's URL.
  Before any `supabase db push`, check `supabase/.temp/project-ref`.
  Production `fhrvtgizyhmxsduwxfwn`, staging `coyqcoefivrgsfsmrncq`.
- **Never delete or rewrite client data in production** (owner's standing
  rule). Before/after production migrations, snapshot counts and dues and
  confirm they match. Verify against throwaway staging data, not real agencies.
- Verify UI changes in a real browser (Playwright against the e2e dev server on
  :3100 with staging), both themes and phone width, zero console errors.
- **Sign-in security** (migration 000055): every guard enforces the 2FA gate
  (`securityGatePath()` in `src/lib/auth/types.ts`); only fns that must work
  mid-sign-in (`src/server/auth/mfa.fns.ts` setup/verify) may use
  `requireSignedIn()`. 2FA is mandatory for platform admins. Any page that takes
  a password or code must render `<form method="post">` (a pre-JS native submit
  must never put credentials in the URL). Public signup is disabled in Supabase
  on purpose; create accounts with the admin API. Auth emails go through
  Hostinger SMTP, and the "Change email address" template must link to
  `/confirm-email?token_hash=…`, never `{{ .ConfirmationURL }}`
  (`docs/DEPLOYMENT-HOSTINGER.md` §4).
- **Monitoring** (migration 000054): a new scheduled job records itself with
  `startCronRun`/`finishCronRun` (`src/server/monitoring/monitoring.service.ts`).
  Server-fn errors are captured by the global middleware in `src/start.ts`. A
  refusal the user caused and can fix (wrong password, expired link) throws
  `UserError` (`src/lib/errors/user-error.ts`) so it isn't logged; add other
  names to `isExpectedError()` only if genuinely normal operation.
- **New database functions are service_role-only by default** (migrations
  000050–52). Never rely on `revoke ... from public` alone. A function an RLS
  policy calls needs `grant execute ... to authenticated` AND an entry in
  `POLICY_HELPERS` (`src/server/security/client-exposure.test.ts`).

## Architecture

- **Three areas**: `/platform` (the vendor; `isPlatformAdmin` only),
  `/agency` (one agency's own data; ADMIN/SUPER_ADMIN), `/client` (one client's
  own data; CLIENT). Renamed from `/admin` and `/portal` on 2026-09-15 —
  `docs/HISTORY.md` still uses the old names. The areas don't cross-link.
  `homePathForUser()` routes a platform admin to `/platform` first.
- **Tenancy**: `organizations` = agencies. Org zero
  (`DEPLOYMENT_ORGANIZATION_ID`, `00000000-…-0001`) is xRush Agency. Every
  tenant table carries `organization_id`. That id isn't a valid RFC-4122 UUID,
  so organization ids use a shape regex (`src/schemas/organization.ts`), not
  `z.uuid()`.
- **`is_platform_admin` (cross-org, vendor) ≠ the `SUPER_ADMIN` role
  (one agency's top admin).** The platform account `rush@xrush.online` is
  deliberately role CLIENT + `is_platform_admin`, with no memberships. Never
  "fix" it to SUPER_ADMIN — that would hand it xRush's books.
  `displayRoleFor()` labels it "Platform Owner".
- **The server layer bypasses RLS** (service-role key), so RLS is only defence
  in depth. Every query in `src/server/**` must scope by the caller's
  `organization_id`: filter reads, tag inserts, and check ownership before
  acting on a row by id. RPCs that act on a row take `p_organization_id`.
- **Platform pool**: ad accounts owned by the platform (`is_platform = true`,
  `organization_id` NULL) are lent to one agency at a time via
  `platform_account_grants`. An agency's accounts = owned ∪ granted, defined
  ONLY in `src/server/ad-accounts/scope.server.ts` (`applyAdAccountScope` is
  synchronous on purpose; mutations use authorize-then-act via
  `loadAccessibleAdAccount`, never `.eq('organization_id', me)`, which
  silently misses granted rows). `operatingOrganizationId()` gives a pool
  account's holder for audit/notifications.
- **NULL trap**: never guard with `organization_id <> p_org` — NULL makes the
  guard silently pass (a real IDOR, fixed in 000036). Use
  `org_can_use_ad_account()` / `EXISTS`.
- Pool accounts survive an agency's offboarding and "Clear all data". Platform
  support view (`/platform/organizations/$id/data`) is read-only and writes its
  audit row into the VIEWED agency's org, on purpose.
- **Deletion order**: FKs to `organizations` and `auth.users` have no ON DELETE.
  A new table referencing them goes into `OFFBOARD_ORDER`
  (`organization.fns.ts`, + `offboarding.test.ts`) and, if it's business data,
  `WIPE_ORDER` (`maintenance.fns.ts`). Accounts that ever acted can't be
  deleted — deactivate them instead.
- **Subscriptions**: a suspended org's users are gated in `loadUserOrThrow()`
  and the route guards (platform admins bypass). Any new path that adds an
  active client, ad account or staff login must call `assertPlanAllows()`
  (`src/server/subscription/plan-limits.service.ts`).
- **Multi-client logins**: one login can belong to several clients; the active
  one is the `rt_active_client` cookie (`resolveActiveClientId`), which
  `requireClientMembership()` defaults to. Switching is a hard navigation
  (query keys aren't client-scoped).
- **Notifications**: `notifyAdmins()` needs an `organizationId`;
  `notifyClientMembers()` sets `client_id`; `notifyPlatformAdmins()` for the
  vendor. The unread count is global; the list follows the active client.
- **Telegram**: `notifyTelegram()` addresses exactly one tenant — never loop
  over every agency. `platform_admin` chats use the platform bot
  (`TELEGRAM_PLATFORM_BOT_TOKEN`), agency/client the shared bot
  (`botKindFor()`). A new event type goes into `TELEGRAM_EVENT_TYPES`
  (`src/lib/telegram/event-types.ts`).

## Domain rules and naming traps

- **Similar names, different things** — keep them apart in code and UI:
  - `ad_account_assignments` (account → **client**) vs
    `platform_account_grants` (account → **agency**).
  - `limit_requests` (client raises a cap) vs `platform_account_requests`
    (`AAR-…`, an agency asks the platform for a new account).
  - **Remaining** = Meta `spend_cap − amount_spent`; **Current balance** = the
    client's due (our ledger); **Meta Due / Balance owed to Meta** = Meta's own
    `balance`. Never reuse one label for another.
  - Team Members (a client's own logins, `client_memberships`) vs the removed
    Employees feature. The `employees`/`client_employees` tables still exist on
    purpose — don't drop them.
- **Money**: due is never stored — always derived from `ledger_entries`
  (`client_financials()`). Corrections only add rows (adjustments, reversals);
  approved records are immutable. Multi-step financial writes are row-locked
  `SECURITY DEFINER` RPCs (`approve_limit_request`, `approve_payment`,
  `submit_payment`, assign/release/transfer). Errors raised as `CODE: message`
  are unwrapped by `friendlyRpcError()`.
- **Net Receivable / Amount Payable** = ledger due − unused ad balance
  (Σ max(0, spend_cap − spent), active USD accounts) — display only, never
  stored (`src/lib/money/net-due.ts`, `net-due.fns.ts`). Client sees ≥ $0 plus
  a credit balance; agency sees "Net Credit". Clients never see Meta Due.
- **USD rate**: `adAccountUsdRate()` (`src/server/exchange-rates/rate.service.ts`)
  — the account's `usd_rate` wins; `0` means inherit the client's rate.
  Assign/transfer copy the client's rate onto the account (000057). The
  `exchange_rates` table is history only.
- **Client segments**: `prepaid` (pays full cost up front), `partial` (pays
  part, rest becomes due), `postpaid` (all due). Segment is read server-side and
  snapshotted on each request.
- Codes (`CL-0001`, `ADA-0001`, `LR-…`, `PAY-…`) are DB sequence defaults —
  the server never sets them; ids stay UUIDs. Proof files live in the private
  `proofs` bucket, served by 60-second signed URLs (`storage.service.ts`).
  Writes go through the server layer with `writeAudit()` after (best-effort) or
  inside the RPC. Pure logic lives in `src/lib/**` so it's unit-testable.
- **Supabase numerics arrive as JS numbers** at runtime even though the types
  say `string` — wrap with `String(...)` when seeding form defaults (this bug
  broke edit dialogs twice).
- **Meta integration**:
  - Credentials resolve per account via `metaCredentialScopeFor()` →
    `{kind:'platform'}` or `{kind:'organization', id}`. The `META_*` env vars
    are the PLATFORM's (`platform_settings` overrides them); an agency's own are
    in `app_settings`. No org-zero fallback: an agency without credentials has
    no Meta.
  - Listing a portfolio needs BOTH `owned_ad_accounts` and `client_ad_accounts`.
  - Units: `amount_spent`/`spend_cap`/`balance` READ in minor units (normalised
    in `toSummary()`, with `ZERO_DECIMAL_CURRENCIES`), but `spend_cap` WRITES in
    major units (verified live). Don't "fix" the asymmetry.
  - Meta's portfolio edges (`listMetaBusinessAdAccounts`) return STALE
    `amount_spent`/`balance` — for figures shown to users read each account's
    own node (`fetchMetaAdAccounts`). Shown figures live in the `meta_*`
    snapshot columns (`refreshMetaSnapshots()`), display only, never a limit.
  - Money comparisons are USD-only, no FX; threshold alerts check
    `currency === 'USD'` (`LOW_BALANCE_THRESHOLD` ≤ 60, `META_DUE_THRESHOLD`
    100, `src/lib/meta/thresholds.ts`). Format Meta money with
    `formatCurrencyAmount()`, not `formatUsd`/`formatBdt`.
  - Meta's `account_status` is display-only; our `ad_accounts.status` stays
    admin-controlled. Bulk import never sets a limit from Meta's spend cap.
  - Manual spend-cap push/pull/retry on a pool account is platform-only
    (`canMutateSpendCap()`). The automatic push after a limit approval
    (`syncAndPersistAdAccountSpendCap`) must stay ungated, and a Meta failure
    never rolls back an approval (it flags `meta_sync_pending`; the cron retries).
  - A limit request on a pool account can't be approved by the agency — only
    rejected or sent to the platform (`PENDING_PLATFORM_REVIEW`).

## Framework conventions that bit us already

- Stack (don't downgrade or swap): TanStack Start 1.168 as a **Vite plugin**
  (no `app.config.ts`/vinxi), TanStack Router file routes in `src/routes`, Vite
  8, Nitro v3 (`node-server` build on Hostinger), React 19, TS strict,
  Tailwind v4 (CSS-first, `src/styles.css`), shadcn/ui, Supabase
  (`supabase-js` + `@supabase/ssr`), Zod v4 (`z.email()`, not
  `z.string().email()`), React Hook Form, decimal.js.
- **Import protection** (enforced at build): `*.fns.ts` = `createServerFn`
  endpoints, safe to import anywhere; `*.server.ts` = server-only. Shared
  server helpers live in plain `*.service.ts` modules used only inside handler
  bodies — never export a helper from a `.fns.ts` for another `.fns.ts` to
  import, and never type a param as `ReturnType<typeof getSupabaseAdminClient>`
  in a `.fns.ts` (use `SupabaseClient`). Both break the client build.
- `createServerFn().validator(schema)` (`.inputValidator()` is deprecated).
  Request helpers come from `@tanstack/react-start/server`.
- HTTP endpoints (cron, webhooks) are files under `src/routes/api/**` with
  `server.handlers`; a top-level `server/` dir is NOT wired in.
- A child route next to a flat leaf turns the leaf into a layout: rename the
  leaf to `….index.tsx`.
- The root `beforeLoad` puts the session in `context.user`; area layouts
  (`src/routes/{platform,agency,client}/route.tsx`) guard on it.
- CSS: global element rules go in `@layer base`, or they beat Tailwind
  utilities. Dark mode is `[data-theme="dark"]`. Use the shared `StatCard`
  (hints above the value), `.num` for figures, `StatusRail`.
- Migrations: never edit an applied one — add a corrective one. A new enum
  value needs its own migration before use; changing an RPC's signature needs
  drop + recreate. The CLI's migration history is in sync with production —
  keep applying through `supabase db push`.

## Security rules (non-negotiable, spec §5, §58–60)

- The browser Supabase client (`src/lib/supabase/client.ts`) is for auth flows
  only; all business reads/writes go through server functions.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only, never `VITE_`-prefixed.
- Every business server fn calls a guard from
  `src/server/auth/guards.server.ts` (`requireUser` / `requireAdmin` /
  `requireClientMembership` / `requirePlatformAdmin`) first. Route guards are
  UX only.
- RLS: SELECT-only policies for `authenticated`, no write policies; tables
  holding secrets or logs get RLS on with zero policies.
- Money: PostgreSQL NUMERIC + RPCs are authoritative; server-side math uses
  decimal.js (`src/lib/money`). Never trust a frontend-computed amount.

## Commands

- `npm run dev` (:3000, needs `.env`), `npm run typecheck`, `npm run build`,
  `npm run generate-routes`
- `npm test` — Vitest unit tests + live-DB tests against staging (skipped
  without `.env.test`). `npx playwright test` — e2e against staging on :3100.
- `npx supabase db push` (needs `SUPABASE_ACCESS_TOKEN`; check the linked ref
  first). Management API (`api.supabase.com/v1/projects/{ref}/…`) for auth
  config and read-only SQL.
- Windows: don't round-trip files through PowerShell 5.1
  `Get-Content`/`Set-Content` (corrupts UTF-8 `§`/`—`).
