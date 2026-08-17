# Changelog

Daily log of what changed in Rush Tracker. One dated section per day of
work; newest at the top. Written by whoever (or whichever agent) makes the
changes — see the "Changelog convention" note in `CLAUDE.md`.

---

## 2026-08-17

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
