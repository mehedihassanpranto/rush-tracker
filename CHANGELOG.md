# Changelog

Daily log of what changed in Rush Tracker. One dated section per day of
work; newest at the top. Written by whoever (or whichever agent) makes the
changes — see the "Changelog convention" note in `CLAUDE.md`.

---

## 2026-08-30

**Ad account detail page's Usage tab now sorts newest-first.**
`listAdAccountUsageFn` (`limit-request.fns.ts`) was ascending
(`approved_at`); changed to descending on owner request. Safe reorder —
`totalUsage` is an order-independent client-side sum and every row's
opening/approved/new-limit figures are already complete per-row values,
not computed from adjacent rows — so nothing else needed to change.
Client detail page's Limit Requests tab already sorted this way; both now
match.

**Ad account "Threshold" field (manual, admin-only) — migration NOT YET
APPLIED to the live project.** Requested to mirror Meta's own "you'll pay
when your balance reaches $X" auto-charge trigger (Ads Manager Billing
page) on the ad accounts list. Investigated first, not assumed: confirmed
live against the real Graph API (fetched a real linked account with an
expanded field list, then probed candidate field names — `billing_threshold`,
`bill_amount`, `threshold`, `payment_threshold`, `min_billing_threshold`,
`next_bill_date`, `next_bill_amount`, `current_bill_amount` — all rejected
as nonexistent fields) that this value is not exposed anywhere in the
Marketing API; it only lives in Meta's own billing-settings UI. So it's a
plain admin-entered reference value, same pattern as `current_limit_usd` —
no live-data relationship to anything Meta-fetched, never synced.
New `ad_accounts.threshold_usd` column (migration
`20260723000025_ad_account_threshold.sql`, `numeric(18,2) not null default
0 check (>= 0)`, same shape as `current_limit_usd`). Editable only through
the existing admin Create/Edit ad account dialogs (`account-dialogs.tsx`),
gated by the same `ad_accounts.manage` permission as every other account
field — no separate permission introduced, since this is just one more
field on the same admin-only form. Shown as a new **"Threshold"** column on
`/admin/ad-accounts`, placed immediately after "Meta Due" per the request
(`—` when unset/0), and as a new "Threshold" row on the ad account detail
page's Account details card (after "Current limit"). `npm test`/typecheck
both pass unchanged (49 tests). **Owner must apply the migration via the
SQL editor or `supabase db push`** — no DB connection is available in this
dev environment to apply it directly (though read-only access via the
service-role key was used to confirm `app_settings` has no override rows
and to pull real ad account ids for the live Graph API probe above).

---

## 2026-08-25

**Edit amount before approving a payment (postpaid/partial clients) — migration
NOT YET APPLIED to the live project.** Requested so an admin can correct a
payment's amount before crediting the ledger (e.g. the proof shows a
different figure than what the client typed on submission). `approve_payment`
extended with an optional `p_amount_bdt` parameter — when provided it updates
`payments.amount_bdt` and the amount is used for the ledger credit, all
inside the same row-locked transaction as before (no separate write that
could race). Migration `20260723000024_approve_payment_amount_override.sql`
drops and recreates the function (Postgres requires this for a signature
change, same pattern as the earlier `approve_limit_request` change).
**The TS call only sends `p_amount_bdt` when an admin actually edits the
amount** — a plain approval still calls with just the original 2 named
params, so normal approvals keep working against the pre-migration function
signature; only the new edit feature needs the migration applied to
function (attempting an edit before the migration lands will fail with a
clear DB error, not a broken approval flow generally).
UI: `/admin/payments/$paymentId`'s Verify card gets an "Amount to credit"
row with an Edit button when the payment's client is `postpaid` or
`partial` — not shown for `prepaid` clients, since a prepaid client's
payment is auto-recorded by `approve_limit_request` to exactly match the
frozen `amount_paid_bdt` on that limit request, and editing it here would
silently desync the two. Editing shows an inline number input (validated
>0) and the bottom "Approving credits ৳X" line updates live to the edited
figure before submit.
**Real bug found and fixed during verification**: `setAmountDraft(payment.amount_bdt)`
crashed with `amountDraft.trim is not a function` the moment "Edit amount"
was clicked — Supabase returns `numeric` columns as JS numbers at runtime
despite the TS type saying `string` (the same class of bug found and fixed
earlier this session for `usd_rate`/`current_limit_usd`). Fixed by wrapping
in `String(...)`. Verified live against a real pending payment
(`PAY-000010`, DF IT Solutions, ৳39,000): Edit button appears, input
pre-fills correctly, `0` correctly disables Approve with a visible error,
a valid edited amount re-enables it and updates the confirmation text —
deliberately stopped short of clicking Approve itself, since that would
irreversibly credit a real client's ledger and wasn't asked for.
**Owner must apply the migration via the SQL editor or `supabase db push`**
before using the edit-amount feature — no DB connection is available in
this dev environment to apply it directly.

**Billed vs. Paid & Due donut chart on the Client Due Report** — requested
as "a pie chart for billed, paid and current due." Built as a 2-segment
donut (Paid, Current Due) with Billed as the center total, not a literal
3-slice pie: Billed = Paid + Current Due (ledger-derived, spec §35), so a
3-way split would double-count the total and mislead. New
`src/components/reports/due-breakdown-donut.tsx` — pure SVG (no chart
library added), totals summed client-side from the report's own rows via
decimal.js. Center label swaps to the hovered/focused segment's value and
percent (same treatment for mouse and keyboard, no floating tooltip to
position/clip); legend rows mirror the same interaction; every value is
also visible at rest in the legend (never color-alone) and in the
existing per-client table right below. Colors are a dedicated
`--chart-paid`/`--chart-due` pair (`styles.css`) — light mode reuses
`--success`/`--warning`, but dark mode needed distinct, deliberately
deepened hexes (`#2f9968`/`#b07f2a`) since the existing dark
`--success`/`--warning` are too light to pass as large chart fills;
colorblind-safety validated both modes with the dataviz skill's
`validate_palette.js` before shipping. Verified live in both themes
(zero console errors) via the standard temporary-Playwright pattern.

**Fixed: active sidebar nav text (and any Link with its own text-color
class) was invisible** — `a { color: var(--link) }` in `styles.css` sat
outside every Tailwind `@layer`, so per CSS cascade-layer rules it always
beat any `text-*` utility (Tailwind wraps its own utilities in
`@layer utilities`) regardless of class order — silently overriding the
color on every `<Link>`/`<a>` app-wide the whole time. Invisible in
practice under yesterday's palette only by coincidence (`--link` and
`--primary` were different hues); once yesterday's rebrand gave them the
same blue, the active nav pill rendered blue text on a blue background.
Fixed by moving the rule into `@layer base`, so Tailwind's utility layer
correctly wins when a link has its own color class. Also added
`suppressHydrationWarning` to `<html>` — a leftover dev-console warning
from the theme-init script setting `data-theme` before React hydrates
(expected/correct behavior, just needed the standard React opt-out).
Verified live: active nav pill text now renders white (light)/near-black
(dark) as designed; a table `Link`'s `text-primary` renders the intended
blue in both themes; zero console errors.

**Fixed: ad accounts list always showed ৳130 for "Per USD" regardless of
client** — two related issues:
- **Display bug**: the list (and the client detail page's Ad Accounts tab,
  and the ad account detail page's Account details card) showed the
  account's raw stored `usd_rate` only, never falling back to the client's
  own rate the way actual billing does (`adAccountUsdRate()`,
  `rate.service.ts`: account rate wins when set; 0/unset inherits the
  client's rate). `AdAccountClient` (`types/domain.ts`) gained `usd_rate`;
  `currentClientMap()` (`ad-account.fns.ts`) and `listClientAccountsFn`
  (`assignment.fns.ts`) now select it. All three surfaces now show the
  resolved effective rate, italicized when it's inherited rather than the
  account's own override, so admins can tell at a glance why two accounts
  under different clients show different figures.
- **Data**: live query confirmed literally every one of the 33 ad accounts
  carried an explicit non-zero `usd_rate` (mostly ৳130, one ৳132) from an
  old bulk-import batch — so the display fix alone changed nothing
  visible. Two currently-assigned accounts were billing at the stale ৳130
  instead of their real client's configured rate: `ADA-0018` "xRush Agency
  - Azalyn" (client xRush Agency, real rate ৳1) and `ADA-0014` "xRush ADA:
  Zini" (client Foysal bhai, real rate ৳129). Owner confirmed clearing
  both. Done through the real Edit dialog (not a raw DB write) so it went
  through the normal `updateAdAccountFn` path and audit trail — verified
  live: both `usd_rate` now `0` (inherit), correct `AD_ACCOUNT_UPDATED`
  audit rows (`130 → 0`), and the list now shows ৳1 / ৳129 in italics for
  those two rows. The other 31 accounts' ৳130 was left untouched — their
  clients are genuinely configured at ৳130 too, so no mismatch exists.

## 2026-08-24

**"Financial ledger" visual design system** — a styling-only pass (no
business logic, data fetching, or component structure touched) replacing
the earlier amber/teal brand palette with a finance-grade look: cool
grays, a single blue accent reserved for actual interactive actions, and
explicit success/warning/danger tokens for budget/payment health signals.
- **Fonts**: IBM Plex Sans (UI text) + IBM Plex Mono (every numeric value —
  spend, balances, percentages, counts), loaded via the existing Google
  Fonts `@import` in `src/styles.css`. New `.num` utility class
  (`font-family: var(--font-mono); font-variant-numeric: tabular-nums`) and
  a `<Num>` component (`src/components/shared/num.tsx`) — applied to every
  location the spec named: dashboard KPI cards + section-list amounts, the
  ad accounts/clients/payments list money columns, the ad account detail
  page's Account details card, Meta live data card (Amount spent/
  Remaining/Spend cap/Balance owed to Meta), Assignment History (Opening/
  Closing/Spent Amount), the Usage tab (Total USD used + table), and the
  Edit Meta spend cap dialog's cap/spent/estimated-new-cap figures.
- **Palette**: rewired onto the *existing* shadcn variable names (no
  parallel `--bg`/`--surface` tokens alongside `--background`/`--card` —
  wired through `@theme inline`, this project's Tailwind v4 CSS-first
  equivalent of a `tailwind.config` `theme.extend.colors` block, since
  there's no `tailwind.config.js` to edit). `--primary`/`--link`/
  `--sidebar-primary` now share one accent blue (`#2f6fed` light /
  `#5a93ff` dark), reserved for buttons/links/active nav only — never used
  to tint informational cards. New `--success`/`--warning`/`--danger` (+
  `-bg` variants) tokens, reserved for budget/payment health only. New
  `--surface`/`--surface-alt`/`--border-strong`/`--text-secondary`/
  `--text-muted` tiers for finer-grained neutral surfaces than the old
  single `--muted`. `--radius` unchanged (already 10px). Existing
  hardcoded status colors (StatusBadge, due-amount urgency, low-balance
  bells) were left as-is except where they directly overlap the new status
  rail's own domain (see below) — a full sweep of every hardcoded
  `red-600`/`emerald-600` in the app was out of scope for this pass.
- **Status rail**: a 3px, never-rounded colored left border encoding
  budget/payment health at a glance (`src/components/shared/status-rail.tsx`
  — `railClassName()` for table rows, `<StatusRail>` for card use; CSS in
  `styles.css`, deliberately unlayered so it always wins over Tailwind's
  layered `border-l-*` utilities regardless of class order). Applied to:
  ad accounts list (on-track/near-cap/over-cap from the same Meta
  remaining/Meta-due figures already computed for the bell icons and
  Remaining/Meta Due columns, USD-only), clients list (sum of the client's
  own linked accounts' remaining, same thresholds), payments list
  (APPROVED → on-track, PENDING → near-cap, REJECTED/CANCELLED →
  over-cap). Rows with no Meta data (unlinked, non-USD, or the bulk fetch
  hasn't resolved) show no rail color rather than a false "on-track."
- **Dark mode, newly real**: the app had a `.dark` CSS block and `dark:`
  utility classes sprinkled throughout (status badges, due-amount coloring,
  low-balance bells) that were inert dead code — no toggle mechanism
  existed. Switched the `@custom-variant dark` selector from `.dark` to
  `[data-theme="dark"]`, so every existing `dark:` class across the app
  lit up with zero per-component changes. New `src/lib/theme/theme.ts` +
  `<ThemeToggle>` in the header (next to the notification bell): persists
  the choice in `localStorage` (`rt-theme`), defaults to system preference
  when unset, and a blocking inline `<script>` in `__root.tsx` sets
  `data-theme` before first paint (no flash of the wrong theme).
  Verified live (temporary Playwright install, same pattern as earlier
  sessions, removed after): login page and the dashboard/ad accounts/
  clients/payments admin pages in both themes — status rails, tabular-nums
  figures, and the sidebar/header chrome all render correctly light and
  dark.

**Verified everything from today's session live, and found + fixed one more
real bug while doing it** — after the owner applied both pending migrations,
re-ran every fix end-to-end against the live app rather than trusting the
earlier static checks:
- **Multi-client login + notification scoping, confirmed via real writes**:
  created a real payment request against a client the test account belongs
  to and confirmed the resulting notification correctly got the new
  `client_id` set (`find_auth_user_by_email`/`notifications.client_id`
  migrations both confirmed live). Then, using the actual real
  multi-membership account from earlier testing, created a second payment
  request against its *other* client and confirmed — with the portal
  actually open in a browser — that the notification **list** only shows it
  after switching the active client to that one, while the unread **count**
  badge stays identical (8) regardless of which client is active. All test
  payment requests/notifications/audit rows were deleted afterward.
- **New bug found while verifying the USD-rate fix**: the ad account Edit
  dialog (`AccountEditDialog`) and the client Edit dialog
  (`ClientFormDialog`) both failed to save **even with zero changes** —
  "Invalid input: expected string, received number" on `current_limit_usd`
  and `usd_rate` (accounts) / `usd_rate` (clients). Root cause: both
  dialogs seed `defaultValues` straight from the numeric prop
  (`account.usd_rate`, `client.usd_rate`, etc.), but Supabase returns
  `numeric` columns as JS **numbers** here — contradicting this repo's own
  documented convention ("NUMERIC columns come back from supabase-js as
  strings," `client.fns.ts`'s header comment) — while both dialogs'
  `z.string()`-based schemas require an actual string. This was **already
  broken before today's rate-inheritance change** — confirmed by testing
  with a completely untouched, freshly-opened dialog. Fixed by wrapping
  each numeric default in `String(...)` in both dialogs. Re-verified the
  USD-rate fix specifically via a real round-trip on a live, unassigned
  account (ADA-0007): cleared "Per USD" to blank through the actual Edit
  dialog UI, confirmed the DB value became `0`, then restored it to its
  original `130` — net-zero change, but proves the whole path (UI → schema
  → server fn → DB) now genuinely works, not just typechecks.

**Fixed: a client's own USD rate was silently ignored because every ad
account form forced an explicit, non-zero "Per USD" rate** — `rate.service.ts`'s
`adAccountUsdRate()` has always correctly implemented "account rate wins if
set, otherwise fall back to the client's rate," but every place that
creates/edits an ad account's rate (`schemas/ad-account.ts`,
`account-dialogs.tsx`'s create/edit dialogs, `schemas/meta.ts` +
`meta-import-dialog.tsx`'s bulk import) required the rate to be `> 0`,
making the "0 = inherit from client" state unreachable from the UI. In
practice this meant admins were forced to type a rate for every single
account (individually, or once as a "default rate" applied to an entire
Meta-import batch), permanently pinning that account away from ever
following its client's own configured rate again — confirmed live: every
existing ad account in the project has an explicit `usd_rate` (mostly
130, matching the bulk-import dialog's old `130.00` placeholder), so a
client's own rate has effectively never taken effect for any account
created after per-account rates shipped. Fixed by relaxing all four
`usd_rate` validators from "must be positive" to "must be non-negative" —
0/blank now means what `rate.service.ts` already documented it should
mean. Updated labels/placeholders/helper text on both the account create/
edit dialogs and the Meta bulk-import dialog to explain the inherit
behavior, and fixed a small pre-existing bug where the create dialog's
`usd_rate` field wasn't included in its on-open `form.reset()` (so a
previously-typed value could linger across dialog opens).
**Live data note, not auto-fixed**: two real accounts currently show the
exact symptom reported — `ADA-0014` ("Foysal bhai", client rate ৳129,
account pinned at ৳130) and `ADA-0018` ("xRush Agency", client rate ৳1,
account pinned at ৳130). Left as-is rather than silently edited — clearing
an account's rate override changes what future limit requests on it will
bill at, so that's the admin's call via the now-fixed Edit dialog (clear
"Per USD" to blank/0 and save), not something to change unprompted.

**Fixed: a login email already used for one client couldn't be added to a
second client** — the admin's "Add login" and the client portal's
self-service "Add teammate" both unconditionally called
`admin.auth.admin.createUser(...)`, which fails with "A user with this
email address has already been registered" the moment that email exists
anywhere in `auth.users` — even though `client_memberships` was already
schema-designed for this (`unique(user_id, client_id)`, not `user_id`
alone — one login legitimately belonging to several clients was already
"theoretically possible" per an earlier CLAUDE.md note, just never
actually reachable). New shared `provisionClientLogin()`
(`src/server/clients/client-login.server.ts`) now looks the email up
first via a new `find_auth_user_by_email` RPC (migration
`20260723000022_find_auth_user_by_email.sql`, `SECURITY DEFINER` since
`auth.users` isn't reachable via PostgREST otherwise) — if the email
already belongs to a **CLIENT**-role login, it's reused (a new
`client_memberships` row is inserted, or an existing INACTIVE one is
reactivated) instead of erroring; if it belongs to an ADMIN/SUPER_ADMIN
staff account, the request is refused with a clear message (that account
could never actually log into the portal anyway —
`requireClientMembership()` rejects non-CLIENT roles). Both `createClientUserFn`
(`client.fns.ts`) and `addTeamMemberFn` (`team.fns.ts`) now share this one
helper instead of duplicating the old logic. UI: both "Add login" dialogs
now show "Existing login linked..." vs "...created" depending on which
happened, and the password field's helper text explains it's ignored when
reusing an account. **Update, later same day: confirmed applied to the
live project** — the owner applied the migration and successfully linked
a real account (`mehedi.h.pranto@gmail.com`) to a second client ("Ahad
Bhai", CL-0004) via "Add login"; verified directly against the
`audit_logs` row this produced (`CLIENT_USER_CREATED`,
`reused_existing_user: true`). This is what surfaced the next bug, right
below.

**Brand-colored table row hover, app-wide** — the shared `TableRow`
primitive (`src/components/ui/table.tsx`), used by every table in the app,
now hovers with a soft amber `bg-accent/50` tint plus a `border-l-2` teal
(`--link`) accent stripe, replacing the generic `hover:bg-muted/50`. One
shared-component change, so every list page (ad accounts, clients, ledger,
adjustments, etc.) picked it up without a per-page edit. New `--color-link`
token registered in `@theme inline` (`src/styles.css`) so `border-l-link`/
`text-link`/etc. utilities exist — the Accent teal brand color previously
only lived in the bare `a { color: var(--link) }` rule, unreachable as a
Tailwind utility class. Verified visually via a hovered-row screenshot
against the live ad accounts list — status colors (red/emerald) inside the
row are unaffected, confirmed at a glance.

**Applied a real brand identity (Ink / Canvas / amber / teal) via theme
variables** — replaced the shadcn default gray/black palette and a leftover,
entirely-unused "ocean" template theme (`--sea-ink`, `--lagoon`, `--palm`,
`.island-shell`, `.nav-link`, decorative `body::before/::after` gradients —
confirmed zero usages anywhere in `src/routes`/`src/components` before
removal) in `src/styles.css`. New brand tokens (`--brand-ink #14171C`,
`--brand-canvas #F7F6F2`, `--brand-primary #C98A2C`, `--brand-primary-deep
#8F5F17`, `--brand-accent #0E7C86`) feed every shadcn CSS variable —
`--background`/`--foreground` (Canvas/Ink), `--primary` (Brand Primary,
`--primary-foreground` set to Ink for correct contrast — computed ~6.5:1 vs
~2.9:1 for white text on this amber), `--chart-1..5` (teal/amber/deep-amber
set), `--ring`, and the previously-unused `--sidebar*` family (now Ink
background / Canvas text / amber active-state, wired into `AppShell`,
`Header`, `SidebarNav`, and the mobile nav `Sheet` for the first time — none
of these components referenced the sidebar tokens before). Added a new
`--primary-hover` token (Brand Deep) and switched `Button`'s default variant
and `Badge`'s default variant off the `hover:bg-primary/90` opacity trick so
hover states use the real Brand Deep hex, not a lightened amber. Generic
`<a>` color now resolves to Brand Accent teal.
**Left untouched, on purpose**: `--destructive` (unrelated to due/urgency
status, already an appropriate red, not worth drifting from red-600) and
every hardcoded status color (`text-red-600`/`text-emerald-600` etc. in
`StatusBadge`, due-amount styling, low-balance bells, Meta Due alerts) —
none of those read from theme variables at all, confirmed by inspecting
`StatusBadge` (always `variant="outline"` with its own literal per-status
classes) and grepping for every `--accent`/`--primary` consumer before
changing either. The internal `text-primary` used for record-navigation
links inside individual page tables (client/account names, etc.) was
deliberately left alone this pass — those still render Brand Primary amber,
not teal, since retargeting them would mean editing className strings
across dozens of route files rather than a shared variable, which was
explicitly out of scope for this first pass ("start with shared layout/
theme variables, verify visually, then individual pages if needed").
Verified visually against the live app (temporary Playwright + magic-link
session injection, same technique as prior verification passes; the
`playwright` npm package was installed with `--no-save` and removed again
afterward — confirmed zero `package.json`/lockfile diff) across the admin
dashboard, ad accounts list, a client detail page, and the client portal
dashboard — Ink sidebar/header with amber active nav, teal links, and all
red/emerald status coloring untouched.

**"Total Remaining" summary card on the client detail page** — added a 6th
card to `FinancialSummary`, positioned right after "Current Due (USD,
approx.)", showing the sum of Meta spend headroom (`spend_cap -
amount_spent`) across the client's own linked ad accounts, USD only (no FX
path, same currency-native gate as the existing Remaining column/bell).
`FinancialSummary` takes a new optional `totalRemainingUsd` prop —
`null`/omitted hides the card entirely (no `ad_accounts.manage`, or the
bulk Meta fetch hasn't loaded yet) rather than showing a misleading
"$0.00"; the portal statement page's own `FinancialSummary` usage is
unaffected since it never passes the prop. Computed client-side in
`$clientId.tsx` by reducing over the same `balanceByAccountId` map that
already powers the Ad Accounts tab's per-row Remaining column — no new
query.

**"Remaining" column on the clients list page** — same figure, one level up:
per-client sum of Meta spend headroom across all their linked USD accounts,
shown as a new column on `/admin/clients`. Reuses the existing bulk
`listAdAccountsFn` (each row already carries `current_client.id`) joined
client-side against the existing bulk `listMetaBusinessAdAccountsFn` fetch —
no new server function, no per-client query. Shows `—` for a client with no
data yet (no `ad_accounts.manage` permission, Meta not configured, or no
linked USD accounts) rather than a misleading `$0.00`.

**"Total Remaining" card on the client portal dashboard** — the same figure
surfaced to clients themselves: `/portal` now shows a "Total Remaining"
card right after "Current Due (USD, approx.)", summing Meta spend headroom
across the client's own linked USD ad accounts. Reuses the existing
`listMyAccountsMetaRemainingFn` query (already powers the per-row
"Remaining" column on `/portal/ad-accounts`) — no new server function.
Hidden (not a `$0.00`) while the query hasn't resolved or Meta is
unreachable, matching the rest of this app's Meta-degradation convention.

**Fixed: a login belonging to multiple clients only ever saw the first
one's data** — the very next bug the multi-client-login fix above
surfaced. Every portal server fn calls `requireClientMembership()` with no
argument, which used to default unconditionally to `active[0]` — the
first client in whatever order the session query happened to return.
Confirmed live: `mehedi.h.pranto@gmail.com`'s second client ("Ahad Bhai")
was correctly linked (real `client_memberships` row, real audit entry) but
completely inaccessible — the dashboard always showed "xRush Digital"
with no way to see the other one. Fixed with a small, low-blast-radius
mechanism rather than threading a `clientId` through all ~20 call sites:
a new `rt_active_client` cookie (`ACTIVE_CLIENT_COOKIE` in
`src/lib/auth/types.ts`) holds which client is "current"; a new pure
`resolveActiveClientId(active, cookieClientId)` picks the cookie's value
if it names one of the user's own active memberships, else falls back to
the first one (never throws on a stale/foreign cookie value — unit
tested, `types.test.ts`). `loadSessionUser()` (`auth.fns.ts`) now resolves
this once per session load and puts it on `SessionUser.activeClientId`;
`requireClientMembership()` (`guards.server.ts`) uses it for its
no-argument default instead of hardcoded `active[0]` — every existing
portal server fn picked this up with **zero changes**, since none of them
ever passed an explicit `clientId` to begin with. New
`setActiveClientFn` (`src/server/auth/portal-session.fns.ts`) is the only
new endpoint — re-validates the target client via
`requireClientMembership(client_id)` (never trusts the request blindly),
then writes the cookie. UI: `/portal`'s previously-decorative client-name
badge row is now a real switcher when a login has more than one active
membership (click a client to switch; the current one is
highlighted/disabled) — clicking does a **hard navigation reload**
(`window.location.assign('/portal')`), not `router.invalidate()`, since
every portal query's cache key is client-agnostic (keyed on
`['client-dashboard-stats']`, not `[..., clientId]`) — only a full reload
guarantees nothing from the previous client survives in the TanStack
Query cache. Also: the portal header (`portal/route.tsx`'s `areaLabel`)
now shows the active client's name on *every* portal page, not just the
dashboard, so it's always clear whose data is on screen even without the
switcher visible. **Verified live end-to-end** against the exact real
account that surfaced the bug — screenshots before/after clicking "Ahad
Bhai" confirm genuinely different data (due amount, ad account, billed
total) on each side, not a UI relabel over the same query result.
**Known, deliberately out-of-scope gap**: `notifications` has no
`client_id` column at all (confirmed — it's purely `user_id`-scoped), so
notifications are shared across all of a login's clients regardless of
which one is "active." Not touched here — a real design decision (scope
per-client vs. keep global), not an oversight, and not what was reported.
Closed the same day — see the next entry.

**Closed the notifications gap above: client-scoped notification list,
global unread count** — new nullable `notifications.client_id` (migration
`20260723000023_notifications_client_scope.sql`), populated only by
`notifyClientMembers(clientId, ...)` (`notification.service.ts`) — the one
notification path that's inherently about a specific client
(limit-request/payment approvals, adjustments, assignments). Admin-facing
notifications (`notifyAdmins()`) stay `client_id: null` and are never
filtered. Two behaviors deliberately split rather than both scoped the
same way: `unreadNotificationCountFn` (the header bell badge) stays
**global** across all of a login's clients — scoping the count to the
active client risked a notification for a non-active client going
completely unnoticed, with no signal to switch and check.
`listMyNotificationsFn` and `markAllNotificationsReadFn` **do** filter to
`client_id is null or client_id = <active client>` for CLIENT-role users
(`user.activeClientId`, from the switcher fix above) — matching every
other portal page's scoping, and keeping "mark all read" from silently
clearing unread notifications on a client the user isn't even looking at.
Portal notifications page shows "Updates for {client name}" instead of
the generic description when a login has more than one active membership.
**Migration NOT YET APPLIED to the live project** — no DB connection
available in this dev environment to apply it directly; apply via the SQL
editor or `supabase db push` before this filtering takes effect (the
column doesn't exist live yet, so `listMyNotificationsFn`'s `.or(...)`
clause would error against a `client_id` column that isn't there).

## 2026-08-23

**Split `prepaid` into `prepaid` (full amount, locked) and `partial`
(editable, was the original `prepaid` meaning)** — client segment is now
three-way: `prepaid` clients must pay the full `total_cost_bdt` to submit a
request (the "Amount paid" field is disabled, always shows the full
amount, and the server ignores any submitted value and computes it itself);
`partial` clients keep the exact behavior the previous entry below
describes (editable amount, 0 < paid ≤ total, rest becomes due);
`postpaid` is unchanged. `approve_limit_request`'s auto-credit condition
widened from `segment = 'prepaid'` to `segment <> 'postpaid'`, since both
prepaid and partial pay something at submission. Two migrations:
`20260723000020_add_partial_segment.sql` (just the enum addition — kept
separate since a newly-added enum value can't safely be used in the same
transaction it's created in) and
`20260723000021_prepaid_full_partial_split.sql` (remaps existing live
`'prepaid'` rows to `'partial'` — found and correctly handled one real
case: `CL-0001` and its already-approved `LR-000012`, ৳1,522 paid of
৳13,000, a genuine partial payment that must not be relabeled `'prepaid'`
under the new stricter meaning — plus the RPC update). Confirmed both
`clients.segment` and `limit_requests.segment` were live and populated
before writing the data migration.

**Added client segmentation (prepaid / postpaid) with partial prepayment
for limit requests.** Every client is now either `prepaid` or `postpaid`
(new `clients.segment`, required, set at creation, editable by admin
later — existing clients backfilled to `postpaid`, matching their actual
behavior to date). Segment drives the limit-request flow:
- **Prepaid**: the client sees the auto-computed total cost
  (`requested_amount_usd × rate`, read-only), enters how much they're
  paying now — pre-filled with the full amount but editable **down**
  (partial payment allowed) — and must attach payment-proof before they
  can submit at all. A live "Fully paid" / "Due balance: ৳X" preview
  updates as they type.
- **Postpaid**: unchanged from the app's original behavior — no payment or
  proof at request time, the full amount becomes due, settled later via
  the existing Pay Due flow.
All of this is enforced **server-side** (`createLimitRequestFn` looks up
the client's real segment itself, never trusts it from the payload;
`total_cost_bdt`/`due_balance_bdt` are computed server-side, never
accepted as client-submitted values).
New `limit_requests` columns: `segment` (snapshotted at request time, so a
later segment change never rewrites past requests), `total_cost_bdt`
(frozen at submission — distinct from the existing `bdt_charge`, which is
computed at *approval* from the admin-editable amount/rate), `amount_paid_bdt`,
`due_balance_bdt`. Migration `20260723000019_client_segment_prepayment.sql`
(existing historical rows backfilled from `requested_amount_usd ×
default_usd_rate`, verified against all 5 real rows before writing).
On approval, `approve_limit_request` now **auto-records a matching
APPROVED payment + ledger credit for `amount_paid_bdt`** (prepaid only,
which may be a *partial* amount — the shortfall becomes real ledger due
automatically, no separate due-tracking mechanism needed) in the same
atomic transaction as the existing debit; postpaid requests are
unchanged — debit only, no auto-payment. `approve_limit_request`'s return
type changed from a bare uuid to jsonb (`ledger_id`, `payment_id`,
`payment_ledger_id`, the latter two nullable for postpaid). The client's
uploaded proof gets linked to the auto-created payment too, so it shows in
Payment History like any other payment. Segment badge + amount
paid/due balance now shown on the admin approval detail page and the
client's own Limit Requests list; the client's "View proof" button there
now shows whenever `segment === 'prepaid'` (proof exists from submission
time, not just after approval — the old condition of `status === 'APPROVED'`
would have hidden it while pending).
**Known caveat**: `total_cost_bdt`/`amount_paid_bdt` are frozen at
submission; if an admin edits the approved amount/rate during review
(still fully supported, unchanged), the auto-recorded payment reflects
`amount_paid_bdt` as entered, which could then not exactly match the
admin-approved figures — the ledger always stays internally consistent
either way (debit and credit are independent, correct entries), but this
is a real-world reconciliation note for admins to know about, not a bug.
**Supersedes an earlier same-day, never-committed design** that forced
*every* client to prepay 100% with no partial option and no postpaid
segment at all — nothing from that design shipped anywhere, so it was
replaced outright rather than layered on top of.

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
