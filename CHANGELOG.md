# Changelog

Daily log of what changed in Rush Tracker. One dated section per day of
work; newest at the top. Written by whoever (or whichever agent) makes the
changes — see the "Changelog convention" note in `CLAUDE.md`.

---

## 2026-09-15

**Platform-side Meta spend-cap controls added — closes the gap the entry below
left open.**

Requested as "shift editing options in the platform manager." Without this,
the 3 actions just locked to platform admins (see the entry directly below)
had nowhere to be performed at all.

New `updatePoolAccountSpendCapFn` / `applyPoolAccountSpendCapFn` /
`retryPoolAccountSpendCapSyncFn` / `fetchPoolAccountMetaFn`
(`src/server/platform/pool.fns.ts`), all `requirePlatformAdmin`. **Deliberately
NOT scoped by grant**, unlike every agency-side ad-account fn — these check
only `is_platform = true`, nothing else, since a platform admin manages the
whole pool regardless of who currently holds a grant. Kept as literal
near-duplicates of the agency-side handlers rather than one shared helper — the
one line that differs (an organization check vs. none) is the entire point of
the split, and folding it in would have obscured that.

Audit rows land in whichever agency currently holds the grant
(`operatingOrganizationId()`, the same helper the cron already used for this)
— same transparency principle as the platform's "View agency data" screen: the
holder sees a platform-made change in its own audit log.

UI: new `PoolSpendCapDialog` (`src/components/platform/ad-accounts/`) —
combines the agency side's two separate dialogs (fetch+apply, edit) into one,
since a pool account has no detail page with tabs to spread them across. Wired
into `/platform/ad-accounts`'s row dropdown as "Meta spend cap", plus a
conditional "Retry sync" item and a `TriangleAlert` next to Current limit when
`meta_sync_pending`.

**Verified live, including the path with no natural test case.** Opened the
dialog on a real granted account (`ADA-0001`) and got real Meta data
($11,100.00 cap / $11,070.40 spent). Since 0 of the 34 live accounts are
`meta_sync_pending` today, temporarily flagged that same account to exercise
"Retry sync" for real — the warning icon rendered, the retry correctly
resolved it against live Meta data with no Meta write (already in sync), and
the account was confirmed back to its exact original state
(`meta_sync_pending: false`, `meta_sync_error: null`,
`current_limit_usd: 11100`) immediately after. Confirmed the negative case
too: xRush's own agency admin still redirects to `/agency` when hitting
`/platform/ad-accounts` directly. `npm test` 83/83, typecheck and build clean.

---

**Manual Meta spend-cap actions restricted to the platform, on
platform-assigned accounts only.**

First slice of the "Mother Platform Account Control" spec the owner pasted for
review. Checked every table it proposed against the live schema before writing
anything — all 11 were missing, because the concepts already exist here under
different names (`organizations`, `is_platform_admin`, `ad_accounts.is_platform`
+ `platform_account_grants`, `payments` + `ledger_entries`). This is the one
genuinely new rule the spec asked for, not a rename of existing machinery.

**The scope decision was confirmed via `AskUserQuestion`, not guessed.**
Locking ALL writes on a platform-assigned account (the spec's literal
pseudocode) would have stopped xRush editing any of its own 34 accounts the
day this shipped, since 100% of them are currently platform-assigned. So the
lock is narrow: only the 3 actions that reach or pull from the account's own
Meta connection — `updateMetaSpendCapFn` (push), `applyMetaSpendCapFn` (pull),
and `retryMetaSpendCapSyncFn` — now require `isPlatformAdmin`. Rename, status
change, assign/release/transfer, limit-request approval, and viewing live Meta
data (Remaining, Meta Due) are unchanged for every account an agency holds,
owned or granted.

New `canMutateSpendCap(account, actor)`
(`src/lib/meta/credential-scope.ts`, 6 new unit tests):
`!account.is_platform || actor.isPlatformAdmin`. **Deliberately does NOT gate**
`syncAndPersistAdAccountSpendCap`, the automatic sync called from inside
`approve_limit_request` with no actor (confirmed zero diff on
`spend-cap-sync.server.ts` and `limit-request.fns.ts`) — that stays fully
agency-controlled, since it's the side effect of an agency approving its own
client's limit request, not a manual platform-only action.

UI: the ad account detail page's "Edit spend cap" button and out-of-sync
"Retry sync" banner both swap to a "Managed by the platform" note when locked;
`MetaFetchDialog` gained a `canApplySpendCap` prop that does the same to "Apply
as current limit" while leaving the read-only fetch itself untouched.

Verified live against a real granted account (`ADA-0001`, held by xRush):
"Edit spend cap" hidden with the note; "Fetch from Meta" still returns real
Meta data (spend $11,068.21 / cap $11,100.00, proving the read path is
untouched) but "Apply as current limit" is replaced with the note; the actions
menu still shows Rename/Edit details/Fetch from Meta/Deactivate/Release
exactly as before. `npm test` 83/83.

---

**Removed "New account" from the agency ad accounts page.**

Requested: the option isn't needed. Ad accounts now reach an agency either by
grant from the platform pool or by "Import from Meta" — typing one in by hand
was the redundant third path. Removed the header button, its dialog state, and
the `AccountCreateDialog` component itself (267 lines), which nothing else used.

`AccountEditDialog`, `AccountRenameDialog` and `TransferDialog` live in the same
file, so the cut was the real risk here. Verified in a browser on a real account
(`ADA-0003`): the actions menu still offers Rename / Edit details / Fetch from
Meta / Deactivate / Release, and **Edit details opens correctly populated**
(`META`, ad account id, `4400`, `130`, `0`). Nothing was saved. Zero console
errors. `npm test` 80/80, typecheck and build clean.

`createAdAccountFn` and `adAccountCreateSchema` were **left in place** — nothing
calls them now, but they are the whole restore path if the button is ever wanted
back, and the endpoint stays behind `requireAdmin(AD_ACCOUNTS_MANAGE)`. Say the
word to delete them too.

---

**Removed the Employees feature from the agency app.**

Requested: "i dont need the feature right now." Deleted the `/agency/employees`
screen, the Employees tab on the client detail page, the three employee dialogs,
`employee.fns.ts`, `schemas/employee.ts`, the `Employee`/`EmployeeWithClients`/
`ClientEmployeeRow` domain types, the nav item, and the `employees.view` /
`employees.manage` permission constants (so they no longer appear as togglable
permissions on the Users screen).

**The two tables were deliberately left in place.** "Right now" reads as
reversible, and dropping `employees` / `client_employees` would be a one-way
schema change nobody asked for — it would also break the live
`reset_all_data()` RPC, which truncates them, and force edits to `WIPE_ORDER`
and `OFFBOARD_ORDER`. Both are empty anyway (the seeded E1–E6 went in the
earlier "Clear all data" incident), so nothing is being preserved except the
option to bring the feature back. The `employees.view`/`employees.manage` rows
in the `permissions` table are likewise left; **0 role grants and 0 user grants
reference them**, so they are inert.

`WIPE_ORDER`, `OFFBOARD_ORDER` and `offboarding.test.ts` still name both tables
— correctly, since the tables and their FK to `organizations` still exist, and
removing them from the delete order would leave rows behind and break
offboarding. Both lists now carry a comment saying why, so the next reader
doesn't "tidy" them away.

Stale copy fixed in the same pass: the "Clear all data" dialog no longer lists
"employee" among what it deletes, `revoke-grant-dialog`'s comment no longer
cites a delete-employee dialog that no longer exists, and `team.fns.ts`'s note
distinguishing **Team Members** (a client's own portal logins — untouched, and
never the same feature) now says the other side was removed.

Verified in a browser as a real agency SUPER_ADMIN: sidebar is 13 items with no
Employees, `/agency/employees` returns 404, a real client detail page
(`CL-0004`) renders with 6 tabs and no Employees tab, and `/agency/users` no
longer mentions employees anywhere. `npm test` 80/80, typecheck and build clean.

---

**Fixed: the platform account's user menu said "Role: CLIENT".**

Reported as confusing by the platform owner, and it was — the header printed
`user.role` raw. That column is the account's **agency** role, and the platform
account genuinely has none: `handle_new_user()` defaults every new signup to
CLIENT, and `rush@xrush.online` was deliberately left there when the platform
and agency were split into separate accounts. Confirmed live — `role=CLIENT`,
`is_platform_admin=true`, **0 client memberships**, so the CLIENT role grants it
nothing; it is the absence of agency powers, and it is what keeps `/agency`
closed to the account (`isAdminRole()` fails).

`requirePlatformAdmin()` checks only `is_platform_admin`, never the role, so
platform access never depended on that column.

**The label was the bug, not the data** — and the obvious "fix" would have been
harmful: promoting the account to SUPER_ADMIN would make it a super admin *of
organization zero*, handing it xRush Agency's clients and ledger, which is
exactly what separating the two removed. New pure `displayRoleFor()`
(`src/lib/auth/types.ts`, beside `homePathForUser`, 3 unit tests) returns
**"Platform Owner"** whenever `isPlatformAdmin` — including for a dual-hat
account, where platform is the wider power — and the real agency role for
everyone else. The column is untouched.

Verified in a browser: platform → "Role: Platform Owner", agency SUPER_ADMIN →
"Role: SUPER ADMIN", client → "Role: CLIENT". `npm test` 80/80.

---

**URL scheme renamed: `/admin` → `/agency`, `/portal` → `/client`.**

The three areas now read as what they are: **`/platform`** (the vendor plane,
unchanged), **`/agency`** (one agency's own data) and **`/client`** (one client's
own data). `/client` also matches the original spec's `_client` naming.

`src/routes/admin/` → `src/routes/agency/` and `src/routes/portal/` →
`src/routes/client/` (git mv, so history follows), then every quoted route path
rewritten — 50 `/admin` and 19 `/portal` across 21 files. The rewrite only
matched paths at the start of a quoted string (`'/admin`, `"/admin`, `` `/admin ``),
which cannot touch an import specifier since those all begin `@/` — confirmed
zero overlap before running it, so `@/components/admin/**` and
`@/server/admin/**` are untouched. Component directories were deliberately NOT
renamed: they are not URLs, and this was a URL change.

**Nothing outside the router referenced these paths** — checked before starting:
no path is stored in the database, and no server function builds one, so there
is no data migration and no stale link in a notification row.

Route guards and `homePathForUser()` follow automatically; the generated route
tree plus TanStack Router's typed `to` mean a missed path is a type error, not a
runtime 404. 11 stale code comments describing the old routes were corrected in
the same pass, as were `docs/DEPLOYMENT.md`, `docs/SECURITY_REVIEW.md` and
`CLAUDE.md`'s routing-convention paragraph. Log entries in `CLAUDE.md` and this
changelog dated before today still name `/admin` and `/portal`; they are a
historical record and were left as written.

**Verified in a real browser for all three roles** (temporary Playwright +
magic-link sessions, removed after, zero lockfile diff):

| signed in as | `/` lands on | cross-area attempts | old path |
| --- | --- | --- | --- |
| platform admin | `/platform/organizations` | `/agency`, `/client` → `/platform/organizations` | `/admin`, `/portal` → 404 |
| agency SUPER_ADMIN | `/agency` | `/client`, `/platform` → `/agency` | `/admin` → 404 |
| client | `/client` | `/agency`, `/platform` → `/client` | `/portal` → 404 |

Page content confirmed loading on `/agency/ad-accounts`, `/agency/clients`,
`/client/ad-accounts`, `/client/due` and `/platform/settings`, and all **26
sidebar links across the three areas** resolve under their own prefix. `npm
test` 77/77, typecheck and build clean.

**The old URLs now 404 rather than redirecting.** That is the honest result of a
rename and fine while production isn't in real use; if bookmarks or an external
link ever need to survive, legacy `/admin/*` → `/agency/*` redirect routes are a
small separate addition.

---

**Meta integration moved from xRush Agency to the Rush Tracker platform.**
Migration `20260723000037_platform_settings.sql`, **applied**.

The Meta System User token and Business Portfolio ID were modelled as org
zero's — xRush Agency's — credentials: `app_settings` is keyed by
`(organization_id, key)`, and `getMetaConfig()` fell back to the `META_*` env
vars for org zero alone. That was always a half-truth. **All 34 ad accounts
those credentials govern are platform-pool accounts** (`is_platform = true`,
`organization_id` NULL since migration 000035), so the portfolio they point at
belongs to the platform, not to the agency that happens to hold the grants.

New `platform_settings` table: key/value, **no `organization_id` at all**, RLS
enabled with zero policies (identical treatment to `app_settings` — it holds a
live secret). A separate table rather than a reserved id in `app_settings`,
because that column is NOT NULL and FK-constrained, so the platform would have
needed a fake organization row — exactly the conflation being undone. The
`META_*` env vars are now the platform's fallback, and **nothing an agency can
edit reaches them**.

`metaCredentialOrgFor()` returned an organization id and is now
`metaCredentialScopeFor()`, returning a union — `{ kind: 'platform' }` or
`{ kind: 'organization', organizationId }`. `getMetaConfig()`,
`fetchMetaAdAccount()`, `listMetaBusinessAdAccounts()`,
`updateMetaAdAccountSpendCap()` and `isMetaConfigured()` all take that scope.

**New `/platform/settings`** (platform nav) manages the platform's credentials;
`/admin/settings` keeps managing each agency's own. The credentials card is now
one shared component taking a `scope` prop rather than a second copy — the two
screens have identical masking, never-prefill and clearing rules, and a
duplicate would drift.

**Two regressions this would have caused, both prevented:**

- **Every live Meta figure for xRush would have gone blank.** The ad accounts
  list, the clients list and the client detail page all read live data through
  `listMetaBusinessAdAccountsFn`, which fetches *the agency's own portfolio* —
  and xRush no longer has one. New `listUsableMetaAdAccountsFn` instead fetches
  across every credential set the agency can actually reach (its own portfolio
  plus the platform's, for granted accounts), deduped to one Graph call per
  portfolio. Verified live: **34/34 rows still show Remaining and Meta Due.**
  The import dialog keeps the old fn, whose "your own portfolio" semantics are
  the correct ones for importing.
- **Telegram alerts for the pool would have stopped silently.** `alertTelegram()`
  gated on `organizationId !== DEPLOYMENT_ORGANIZATION_ID`; the pool used to be
  synced under org zero's id, so it passed by accident. Now gated on the
  platform scope OR org zero.

**Also added: "Add from Meta" on the pool panel** (`listPoolImportCandidatesFn`
/ `importPoolAccountsFn`, `requirePlatformAdmin`). Without it the transfer would
have removed a working capability: no agency can see the platform's portfolio
any more, and the platform had no import screen, so adding a newly-created Meta
account to the pool would have needed hand-written SQL. Imported accounts are
`is_platform: true`, ungranted, `usd_rate: 0` (no client yet, so nothing to
bill). Audited as `AD_ACCOUNT_CREATED` / `metadata.source:
'PLATFORM_POOL_IMPORT'`.

**Verified live.** `platform_settings` created and empty (env fallback live);
the platform scope resolves and reaches the portfolio (36 accounts); **both
xRush Agency and Arrow Solutions now resolve to "not configured"** — no
borrowing. Write/read/clear round-tripped through the new table using
`META_API_VERSION` only (never the token, and written to the same value as env,
so a mid-test failure changed nothing). RLS proven with a row present: service
role sees 1, the public anon key sees 0 and its write is refused (42501). In a
real browser: `/platform/settings` shows all three fields as "Environment
variable"; xRush's own Settings now shows the token and Portfolio ID as **"Not
set"** (API version still env — it is a protocol version, not a credential);
the pool import dialog lists exactly the 2 portfolio accounts not yet in the
pool, submit disabled with nothing selected. Nothing was imported. Zero console
errors. `npm test` 77/77, typecheck and build clean, Playwright removed with no
dependency diff.

---

## 2026-09-15 (earlier)

**Audit for missing data after the pool migration — one security hole, two
real bugs, no data actually lost.**

Prompted by "find any issues of data missing". Migration `20260723000035` set
`organization_id = NULL` on all 34 ad accounts, so every query still filtering
on that column silently returns nothing. Swept the SQL, the server layer, the
data, and every screen.

**SECURITY — pool accounts bypassed the assignment IDOR guard.** Migration
`20260723000036`, **applied**. `assign_ad_account`, `release_ad_account` and
`transfer_ad_account` checked ownership with
`v_account.organization_id <> p_organization_id`. For a pool account that
column is NULL, and `NULL <> x` is **NULL, not true** — which PL/pgSQL's `IF`
treats as false, so the guard never fired. **Any agency could assign, release
or transfer any pool account, including one granted to a different agency.**

Proven before fixing: agency B assigned a pool account granted only to agency A
to one of B's own clients and it **succeeded**, while the same attempt against
an account A *owned* was correctly refused. After the fix the same attack is
refused and creates no assignment row, while the legitimate holder can still
assign and release both its owned and its granted accounts. Both directions are
now regression-tested.

The replacement asks the question that is actually correct now — *may this
organization use this account?* — owned-by-them OR granted-to-them, the same
union the server layer uses, and NULL-safe because `EXISTS` returns a real
boolean.

**The agency profile reported "Ad accounts 0"** for an agency holding 34
granted accounts — its count still used a plain `organization_id` filter. Now
uses the same union.

**Revoking a grant had no confirmation step**, unlike every other destructive
action here (delete client / employee / agency / admin all confirm). A single
dropdown click silently took a live account away from an agency — and did,
twice, during this session's own browser testing, stripping `ADA-0006`
("xRush Agency - Skinthic 02") from xRush. Restored both times and now
confirmed 34/34. Revoke now goes through a dialog stating that the agency loses
the account immediately and that its clients holding it lose it too.

**No data was lost.** Full sweep across 17 tables: no dangling
`organization_id`, no financial rows orphaned from their client, no ownership
CHECK violations, all 18 active assignments consistent with the agency that
actually holds the account, and every screen reconciles against the database —
ad accounts 34/34, clients 6/6, ledger 83 rows, platform profile and pool both
34. (Search briefly looked empty in the sweep; that was the sweep's own
selector — the page renders a list, not a table.)

`npm test`: 74/74.

---

## 2026-09-14 (17)

**Platform admins can now read an agency's books, deliberately and auditably.**

The owner pointed out that the platform super admin can access all agency
accounts. Measured rather than assumed: it was **already true at the database
layer and invisible at the app layer**. Migration `20260723000031` ends 17 RLS
SELECT policies with `or public.is_platform_admin()`, so signing in as the
platform account with the **public anon key** — exactly as a browser would —
returned 7 clients (including one belonging to a separate seeded agency), 84
ledger entries, 33 payments and 34 ad accounts, plus that other agency's ledger
rows verbatim.

So the power existed and nothing recorded its use. The owner chose to keep it
and surface it properly.

**New: a read-only support view** at
`/platform/organizations/$organizationId/data` — the agency's real clients with
dues, its ad accounts (owned and granted), and its most recent 100 ledger
entries. Reached by an explicit "View agency data" click, not shown inline on
the profile.

**Every open is recorded in that agency's OWN audit log**, not the platform's,
so the customer can see when the vendor looked. Verified end to end: the entry
reads *"Rush Platform — Platform Agency Data Viewed"* at the top of xRush's own
Audit Log. The audit write happens before the data is returned, so an access
counts even if the page never renders, and the page fetches once per visit
(`staleTime: Infinity`) so background refetching cannot inflate the record with
accesses nobody made.

**Read-only on purpose.** Viewing a customer's ledger is support; editing it is
not, and would need its own design.

**The profile footnote was corrected.** It claimed an agency's data "stays
private to them" — true of the UI, false of the database, and now false of the
UI too. It now says the records are one deliberate click away and that opening
them is recorded in the agency's own log.

**Two bugs found by looking at the rendered page, not the code:**

- **The route silently didn't exist.** Adding `$organizationId.data.tsx`
  turned the sibling `$organizationId.tsx` into a layout parent with no
  `<Outlet />`, so `/data` rendered the profile page instead — no error, just
  the wrong screen. Fixed by renaming the leaf to `$organizationId.index.tsx`.
- **The profile reported "Ad accounts 0" for xRush.** Its count still used a
  plain `organization_id` filter, which the pool migration set to NULL on all
  34 accounts. It now uses the same owned-or-granted union as every other read.

---

## 2026-09-14 (16)

**Platform and agency are now two separate accounts.** This was the split
asked for two sessions ago; it needed the account email, which arrived today.

- **`rush@xrush.online` is the platform account.** Organization zero (every
  profile needs one — `organization_id` is NOT NULL), the signup trigger's
  default **CLIENT** role, and `is_platform_admin = true`.
- **`mehedi.h.prantoz@gmail.com` is now xRush Agency's owner only** — still
  SUPER_ADMIN of org zero, no longer a platform admin.

**The CLIENT role on the platform account is deliberate — do not "fix" it.**
`requirePlatformAdmin()` checks only the flag, never the role, so the platform
account needs no agency role to do its job. Giving it ADMIN or SUPER_ADMIN
would hand it access to xRush's clients and ledger, which is exactly the
separation this split exists to create.

**Done in the safe order**, with the old account's access never interrupted:
the new account was created first, proven to sign in **through the real login
form with the real password** (not an injected session) and reach `/platform`,
and only then was the flag removed from the original account. The removal
script refused to run unless the new account was already a platform admin, so
the platform could not be left with none.

**Verified both directions.** `rush@xrush.online`: lands on
`/platform/organizations`, sees both agencies and all 34 pool accounts, and
`/admin` redirects away with no agency data rendered.
`mehedi.h.prantoz@gmail.com`: lands on `/admin`, sees its dashboard and all 34
ad accounts, has no platform nav, and `/platform/organizations` redirects to
`/admin` without leaking Arrow Solutions. Zero console errors on either.

**Closed a dead end this exposed**: a platform-only account holds no agency
role, so `/admin`'s role check bounced it to `/portal` — where it has no client
membership and every query would have failed. `/portal` now redirects platform
admins to `/platform`. Deliberately *not* added to `/admin`'s guard: that would
lock a dual-hat account out of its own agency, which is a migration hazard
rather than a rule worth enforcing.

---

## 2026-09-14 (15)

**Agency offboarding, and the test suite is green for the first time.**

**Delete an agency** — `deleteOrganizationFn` plus a "Delete agency" action on
the agency profile. This is the most destructive action in the app, so it is
guarded in four ways: never your own organization, never the platform's own
(org zero owns the pool credentials and every platform login), the subscription
must already be **Cancelled**, and the platform admin must retype the agency's
exact name. The name is used rather than a fixed phrase because every agency's
screen looks identical — a fixed phrase is easy to type confidently on the
wrong one.

**Why teardown order exists at all:** all 17 multi-tenant tables reference
`organizations(id)` with no `ON DELETE` clause, so the organization row cannot
be removed until its data is gone. `OFFBOARD_ORDER` satisfies those keys; it is
deliberately a superset of "Clear all data"'s `WIPE_ORDER`, which keeps an
agency running.

**Platform-pool accounts survive offboarding.** A customer leaving must not
destroy an account the platform owns and merely lent them — the account returns
to the pool unassigned, its grant removed by cascade. Asserted directly.

**Cancel subscription** is now settable from the UI. It is an end state,
distinct from Suspend's temporary lock-out, and it is the required step before
deletion. Kept on the profile page rather than the list, so terminal actions
sit where the counts of what will be destroyed are visible.

The confirmation dialog states exactly what will go: clients and their ledger
history, owned ad accounts, staff and portal logins — with real counts — plus
the note that pool accounts do not.

**Fixed the long-standing failing test.** `permissions.test.ts` asserted four
sensitive permissions; `finance.view` and `finance.manage` were added back in
commit `0e3e8fe` and the expectation was never updated. It stays an exact
allow-list on purpose — marking a permission sensitive restricts it to
SUPER_ADMIN, and un-marking one quietly widens access, so adding one *should*
fail this test until it is listed deliberately. The count is out of the test
title, which is what let it go stale.

**Verified**: a new gated integration test (`offboarding.test.ts`, 6 tests)
proves the organization cannot be deleted while its data references it, that
`OFFBOARD_ORDER` then satisfies every foreign key, that the agency's own ad
account goes while the granted pool account survives with its grant released,
and that nothing is left behind. The full flow was also driven through the real
UI: Delete blocked while Active with the name field hidden, blocked again on a
mismatched name, then a real deletion that removed the agency and redirected to
the list. Throwaway agency cleaned up; zero console errors.

**`npm test`: 72/72.** First fully green run in this project.

---

## 2026-09-14 (14)

**Platform-owned ad account pool.** A second ownership model for ad accounts:
the platform (the vendor layer, not a customer) owns a central pool and grants
individual accounts to agencies. An agency's accounts are now the union of what
it connected itself and what it has been granted. The
agency-connects-its-own-Meta-credentials flow is untouched. Migration
`20260723000035`, **applied to the live project**.

**Two things in the request could not be built as written, and both were
confirmed before anything was changed:**

- **`ad_account_assignments` already exists** — it is the Phase-2 ad account ->
  *client* table, with 18 live ACTIVE rows, its own RPCs, history UI and ledger
  interaction. The new platform -> agency table is `platform_account_grants`,
  using a deliberately different verb so the two can never be confused.
- **There were no Meta credential rows to re-tag.** Credentials live in
  `app_settings`, a key/value table keyed `(organization_id, key)`, and xRush
  had zero rows there — its credentials are the `META_*` env vars. Those env
  vars are now the platform pool's credential, which is what they already were
  in everything but name.

**All 34 of xRush's ad accounts moved into the pool and were granted straight
back to org zero in the same migration**, so nothing changed for its day-to-day
work — verified in the browser afterwards: all 34 still listed with live Meta
data, clients, balances and alerts intact.

**The union is defined once**, in `src/server/ad-accounts/scope.server.ts`, and
every ad-account read/write routes through it — list, detail, update, rename,
status, dashboard counts, assignable accounts, global search, the usage report
and the Meta functions. The multi-tenant pass had spread
`.eq('organization_id', …)` across ten files by hand; a union repeated that many
times would drift. Mutations now authorize once and act by id, because a granted
account's `organization_id` is NULL and the old double-`.eq()` silently matched
nothing.

**Meta credentials now resolve per account, not per "the current
organization"** — a pool account lives in the platform's Business Portfolio, so
an agency's own token cannot read or write it. The daily cron's unit of work
changed with it: it syncs *credential sets* (each agency's own portfolio, plus
the pool once) rather than agencies. Comparing a portfolio against rows it does
not contain would have reported every one of them as "new to import" and never
renamed any of them.

**Behaviour change worth knowing:** pool accounts survive an agency's
Settings -> "Clear all data". An agency clearing its own data must not destroy
an account the platform merely granted it.

**Panel:** `/platform/ad-accounts` — grant and revoke, one agency at a time per
account (enforced by a UNIQUE constraint, not application code), audited as
`PLATFORM_ACCOUNT_GRANTED` / `PLATFORM_ACCOUNT_REVOKED`. Granting is push-only.
Agency account rows carry an "Own" vs "Platform assigned" badge.

**Verified** with a real integration test against the live project
(`pool-isolation.test.ts`, 8 tests): two seeded agencies, a pool account granted
to A only, and B proven never to see it — not in the scoped list, not by id
(where it is indistinguishable from a missing row) — while still seeing the
account it owns outright; plus revoke/re-grant, the double-grant constraint, and
a regression test that org zero sees exactly its 34 accounts. Full suite 65/66,
the one failure being the long-standing unrelated `permissions.test.ts` one.

**Rate limits, noted not addressed** (out of scope): the pool runs through one
shared Meta app. At 34 accounts the cron makes 2 Graph calls for the whole pool
— nowhere near a concern yet.

---

## 2026-09-14 (13)

**Meta credentials are now per-agency.** This closes the largest open gap
from the multi-tenant conversion — the one Phase 1B explicitly deferred,
because `getMetaConfig()` took no parameters and scoping the table without
redesigning the Meta call graph would have shipped a Settings screen that
looked per-agency and silently wasn't.

xRush Agency keeps everything configured to date. A new agency starts with
nothing and connects its own Business Portfolio from its own Settings
screen. Migration `20260723000034_app_settings_per_organization.sql`
(**applied to the live project**) re-keys `app_settings` from `key` to
`(organization_id, key)`, backfilling every existing row to xRush.

**The rule that makes this isolation real:** `META_SYSTEM_USER_TOKEN` and
`META_BUSINESS_ID` in the environment are **org zero's credentials only**.
They're set on the deployment by the deployment's owner and point at xRush's
portfolio. Had the env fallback stayed global, a new agency with no
credentials would have silently fallen back to them — seeing xRush's ad
accounts, and able to write spend caps to them. An agency with no
credentials of its own now has no Meta integration, which is the correct
answer rather than a degraded one. (The Graph API *version* is not a
credential and is still shared.)

Threaded `organizationId` through `fetchMetaAdAccount`,
`listMetaBusinessAdAccounts` and `updateMetaAdAccountSpendCap`, and their
callers. The account-level paths take it from the `ad_accounts` row's own
`organization_id`, so an account can only ever be pushed to the portfolio of
the agency that owns it. No client-side code changed — every UI path already
went through a guarded server fn.

**The nightly cron was rewritten to iterate agencies**, each synced against
its own portfolio with its own credentials. One agency's expired token no
longer stops everyone else's sync. Two things fixed along the way:
- **Suspended agencies are now skipped** (both the sync and the pending
  spend-cap retry) — previously they'd keep being acted on nightly despite
  their users being locked out. This was an open item from the gap audit.
- **Telegram alerts fire for org zero only.** There is one chat configured
  on the deployment and it belongs to xRush; sending another agency's
  account names and balances there would leak their data. Other agencies get
  the in-app notification, which is correctly scoped. Per-agency Telegram is
  a separate feature, deliberately not guessed at here.

**Also fixed, found during verification**: the "Import from Meta" dialog
swallowed a failed fetch and fell through to its empty state, so an agency
with no portfolio connected was told *"everything in the Business Portfolio
is already linked"* — confidently wrong, and it hid the one action they
needed to take. It now shows the error, which names the fix.

Verified live against the real project with a throwaway second agency:
xRush's 34 ad accounts and Meta data still load exactly as before (no
regression), the second agency's Settings shows token and Portfolio ID "Not
set" with its own copy, and its "Import from Meta" returns the
not-configured message with **zero of xRush's accounts leaking**. The cron
endpoint was invoked for real: xRush synced (36 checked), Arrow Solutions
and the throwaway both skipped as `not_configured`. Throwaway agency deleted
afterwards; zero console errors.

---

## 2026-09-14 (12)

**Row actions on the agency profile's admin list: Deactivate/Activate and
Delete login.** Requested as a delete button; it ships as two actions
because a delete alone would fail for most real admins.

**Why:** every FK to `auth.users` in this schema (`reviewed_by`,
`created_by`, `assigned_by`, `actor_user_id`, …) was declared with no ON
DELETE clause, so Postgres itself refuses to delete an account that
approved a limit request, verified a payment or wrote an audit row — those
records must keep naming a real person. Delete is therefore only possible
for an account that has never done anything, which is exactly the case
worth supporting (added by mistake, or a duplicate).

- **Deactivate** (`setOrganizationAdminStatusFn`) is the action for
  everyone else: an inactive profile fails `loadSessionUser()`, so access
  is revoked immediately while every record they touched stays intact.
  Reversible from the same menu.
- **Delete** (`deleteOrganizationAdminFn`) checks the audit trail first and
  refuses with a message naming the number of recorded actions and pointing
  at deactivation, rather than letting a raw FK violation surface as a
  database error. If something outside the audit trail still holds a
  reference, that error is translated to the same advice.
- Both are scoped to the (organization, user) pair with a double `.eq()`,
  refuse your own account, and refuse accounts flagged `is_platform_admin`
  — the platform's own access shouldn't be revocable from an agency's
  contact card. Audited as `ORGANIZATION_ADMIN_STATUS_CHANGED` /
  `ORGANIZATION_ADMIN_DELETED`.
- **Deleting an agency's last admin is warned about, not blocked** — the
  dialog says the agency won't be able to sign in until another is added.
  Cleaning up a mistake is legitimate, and "Add admin" on the same card
  makes it recoverable.

Verified live against a throwaway agency with two seeded admins, one given
a recorded action: deactivate → `INACTIVE`, reactivate → `ACTIVE`, delete
refused for the one with history (account untouched), delete succeeded for
the clean one (profile row cascaded away), the last-admin warning renders,
and the platform admin's own row correctly shows no actions menu at all.
Audit rows correct for all three writes. Throwaway agency, users and audit
rows deleted afterwards; zero console errors.

---

## 2026-09-14 (11)

**An agency's first Super Admin can now be created from the platform panel**
— "Add admin" in the agency profile's "Who to contact" card, and a matching
button in that card's empty state, which previously said "No admin logins —
this agency can't sign in" and offered no way to fix it. That case had no
route back other than hand-written SQL, which is exactly what the "New
agency" onboarding flow was built to eliminate.

- New `createOrganizationAdminFn` (`requirePlatformAdmin`). The
  user-provisioning half of `createOrganizationFn` was extracted into a
  shared `provisionOrganizationSuperAdmin()` so both paths create an admin
  identically — including the two fields that matter most
  (`organization_id`, `role_id`), since `handle_new_user()` lands every new
  account in org zero as a CLIENT. Never `is_platform_admin`.
- The email is checked before anything is created, and a failed profile
  update deletes the half-created auth user — the auth API and Postgres
  aren't one transaction.
- Audited as `ORGANIZATION_ADMIN_CREATED`, naming the platform admin, the
  agency, and the email granted access.

**This is a real privilege, and it's stated plainly in the dialog**: the
login it creates can see that agency's own clients and ledger, which no
platform screen can. It is deliberately not restricted to agencies with
zero admins — an agency whose only admin is locked out still has a row and
would otherwise be stranded — so the audit trail is what makes it
accountable rather than a hard gate.

**Also fixed while verifying**: the "Who to contact" table had four columns
in a half-width card and clipped the Status badge off the right edge. Email
now sits under the name, so the table fits.

**Build-time gotcha worth remembering**: `type X = ReturnType<typeof
getSupabaseAdminClient>` in a `.fns.ts` file fails the client build —
a type alias referencing that binding keeps the `*.server` import alive
after the handler bodies are stripped, and import protection rejects it.
Type the parameter as `SupabaseClient` from the package instead.

Verified live through the real UI against a throwaway organization: the
empty-state button, the created admin's profile (correct `organization_id`,
`SUPER_ADMIN`, `is_platform_admin` false), the audit row, and the
duplicate-email refusal (no second auth user created). Throwaway
organization, user and audit row all deleted afterwards; zero console
errors.

---

## 2026-09-14 (10)

**Platform and agency are now fully separate entities, and each agency has
a profile page.** Owner's direction: the platform panel is not a section of
the agency app, and the two should not cross-link.

- Removed "Back to agency" from the platform sidebar and the "Platform"
  doorway from the agency sidebar, along with the `platformAdminOnly`
  nav-filtering machinery that existed only to serve it.
- **A platform admin now lands on `/platform` when they sign in.**
  `homePathForUser()` previously routed purely by role, so a platform
  account would have been dropped into the agency app — which was fine
  while one person wore both hats and wrong as soon as they don't. Covered
  by a test.
- Nothing else in the agency app changed.

**New: an agency profile at `/platform/organizations/$organizationId`**,
reached by clicking the agency name in the list. Shows what they're using
(clients, ad accounts, staff logins, portal logins), the subscription
record (plan, status, created, suspended-at, notes), and who to contact —
the agency's own admins with names, emails and roles. Suspend/activate and
edit both work from the profile as well as the list.

This closes the "no usage metrics per org" gap from the earlier audit:
there was previously no way to see how much of the product an agency
actually used, which is what you'd price a plan on.

**Deliberately aggregate-only.** The profile shows counts and contacts,
never the agency's own clients, ledger or account data. A platform admin
manages subscriptions; reading a customer's books is a different power and
isn't granted here. The page says so in a footnote, so the boundary is
visible rather than assumed.

Verified in-browser against the live database: the profile renders real
figures for xRush Agency (6 clients, 34 ad accounts, 4 staff, 9 portal
logins) and lists all four of its admins. Zero console errors; typecheck
and build clean; tests 49/50 passing (one added, same pre-existing
unrelated failure).

---

## 2026-09-14 (9)

**"New agency" onboarding — the last thing that required hand-written SQL.**
Adding a customer previously meant creating a user in the Supabase dashboard
and running two UPDATE statements; now it's a dialog on the platform panel.

`createOrganizationFn` creates the organization **and** its first
SUPER_ADMIN login together, because half of that job is useless on its own:
an organization with no login can't be reached, and a new admin without an
explicit `organization_id`/`role_id` lands in **org zero as a CLIENT** —
the signup trigger's defaults. Those two fields are exactly what the manual
SQL was for.

Guards against the ways it can go wrong:
- The email is checked **before** the organization row is created, so a
  duplicate doesn't leave an empty agency behind.
- Postgres and the auth API aren't one transaction, so anything failing
  after the org exists rolls it back (and deletes the half-created user)
  rather than orphaning it.
- The new admin is never `is_platform_admin` — they own their agency, not
  the platform.

Verified end-to-end against the live database, driving the real UI: created
an agency through the dialog, confirmed in the DB that the org was active
with its plan and that the admin's profile pointed at the **new** org with
SUPER_ADMIN and no platform flag, then signed in as that admin through the
real login form with the password set in the dialog. They landed on
`/admin` with a completely empty workspace — no Platform nav item, no sight
of xRush's six clients, their own clients list empty. Test agency and user
deleted afterwards, along with the audit rows; xRush Agency confirmed the
only organization remaining. Zero console errors, build clean, tests 48/49
(same pre-existing unrelated failure).

---

## 2026-09-14 (8)

**Platform management split into its own panel at `/platform`.** Owner's
call, ahead of adding more platform-level features: the vendor plane
shouldn't sit inside one agency's admin area.

- New `/platform` layout with its own sidebar (`PLATFORM_NAV`) and guard.
  Organizations moved from `/admin/organizations` to
  `/platform/organizations`; `/platform` redirects there until there's more
  than one screen to show.
- **The guard checks only `isPlatformAdmin`, never the agency role.** While
  the panel lived under `/admin` it inherited that route's role check, so a
  platform admin also had to hold ADMIN/SUPER_ADMIN somewhere just to reach
  it — a platform-only account would have been bounced to `/portal` and
  never seen it. Splitting the areas removes that coupling entirely.
- Two-way doorways: the agency sidebar shows a "Platform" item (platform
  admins only), the platform sidebar has "Back to agency".
- The header's global search is suppressed in the platform panel — it
  searches one agency's own clients and accounts, which is the wrong scope
  in a cross-org area. New `showSearch` prop on AppShell/Header.

`/admin` and `/portal` are untouched; no existing URL changed except the
organizations page itself.

**Also fixed a bug introduced by the design pass earlier today**: StatCard
wrapped its value in a `<p>`, but the loading Skeleton renders a `<div>` —
invalid HTML, and React logged a hydration error on every dashboard load.
Caught by watching the browser console during this verification, not by
typecheck. Now a `<div>`.

Verified in-browser for all three user types: platform admin reaches the
panel, an agency ADMIN hitting `/platform/organizations` is bounced to
`/admin` and never sees the nav item, a client user is bounced to
`/portal`. Zero console errors. Typecheck/build clean; tests 48/49 (same
pre-existing unrelated failure).

---

## 2026-09-14 (7)

**Visual design pass — KPI tiles unified, ledger made readable.** Driven by
screenshotting every admin and portal screen in both themes plus mobile
width, rather than reading the code, so the findings are things actually
visible on screen.

**One `StatCard` replaces three drifted copies** (admin dashboard, portal
dashboard, `FinancialSummary`). Two real bugs fixed in the process:

- *Dead space under every figure.* All three rendered an empty
  `<CardContent />`, which still cost the card's `gap-6` plus `py-6` —
  roughly 60px of nothing under each number. Tiles are ~25% shorter now,
  which on the admin dashboard lifts two more sections above the fold.
- *Numbers didn't share a baseline.* Any label that wrapped to two lines
  ("Pending Payment Verifications", "Total Outstanding Due (BDT)") pushed
  its figure down while its neighbours stayed put, so a row of tiles read
  as ragged. The value is now bottom-anchored, and hints sit above the
  number rather than below it, so figures line up regardless of label or
  hint length.

**Portal grid: 4 columns → 3.** With 7–9 tiles (the two Meta ones are
conditional) a 4-up grid always stranded one card alone on the last row;
9 tiles now fill a clean 3×3.

**Portal figures were not tabular.** The portal never got the `.num`
mono/tabular treatment the admin side has, so the same app rendered money
two different ways depending on which side you were on. Now consistent.

**Ledger debit vs credit were visually identical** — same weight, same
colour, on the one screen whose entire job is showing which direction
money moved. Credits now read in `--success`, debits in neutral bold, and
the empty-side em-dash is dimmed so the eye lands on the real figure.

Verified across light and dark themes and at 390px width. `npm run
typecheck` / `npm run build` clean; `npm test` 48/49 (same pre-existing
unrelated failure).

---

## 2026-09-14 (6)

**Review pass over Phases 2–3 — found and fixed a critical bug that made
the whole subscription gate's user-facing half dead code.** Migration
`20260723000033`, applied and verified live.

The Phase 3 verification had only proved that an *active* organization
isn't blocked; it never tested an *actually suspended* one. Testing that
path (throwaway organization + user, suspended, then requesting `/portal`)
showed it redirecting to **`/login`**, not `/subscription-suspended`.

Root cause: Phase 1's `user_profiles_select` RLS policy gates every row —
including the caller's own — on `is_org_active()`. But the session loader
reads exactly that row to build the session at all. So a suspended org's
user couldn't read their own profile → no session → treated as logged
out. They could never see the suspended page, and logging back in failed
with "account is inactive or not fully provisioned". Notably this exact
interaction was written down as a risk during Phase 1 and then never
closed in Phase 3 — which is why this pass went looking for it.

Fix: a user's own profile row is always readable regardless of
subscription status (it's their own identity row — no isolation lost);
other users' rows still require an org match *and* an active
subscription. The gate itself is unchanged — it lives in the server-fn
guards and the route guards.

Verified after the fix against a real suspended org: CLIENT user →
`/subscription-suspended`, ADMIN user → `/subscription-suspended`,
`/admin/organizations` → same, and the suspended page renders with the
correct copy. Throwaway org and user deleted; org zero confirmed
untouched and still active.

Also hardened: the session loader's organization lookup now logs query
errors explicitly. That lookup fails closed (a failed query is treated as
suspended), so a transient DB blip would bounce a whole organization to
the suspended page — logged loudly so it reads as an outage, not a
billing problem. Whether fail-closed is the right tradeoff is flagged for
the owner rather than changed unilaterally.

---

## 2026-09-14 (5)

**Multi-tenant subscription conversion — Phase 2 (super-admin panel) and
Phase 3 (live subscription gate). All 4 phases now done.**

Phase 2: new `/admin/organizations` page, platform-admin only (a new
`requirePlatformAdmin()` guard, distinct from `requireAdmin()` — this is
the one screen that deliberately sees every organization, not just the
caller's own). List/search/filter, an edit dialog for name/plan/notes,
and an activate/suspend toggle that stamps/clears `suspended_at` and
refuses to let a platform admin suspend their own organization (they'd
personally still bypass the gate, but everyone else in that org would be
locked out — a realistic mistake worth blocking). Both actions audited.
"Organizations" added to the admin nav behind a new `platformAdminOnly`
flag, filtered out for everyone else.

Phase 3: `SessionUser` gained `organizationSubscriptionStatus`, fetched
fresh on every session load via the service-role client (organizations
has no RLS policies for regular users). Enforced in two places: the
shared guard function every protected server fn already goes through
(so flipping the toggle blocks access immediately, not on next login),
and the admin/portal route guards' `beforeLoad` (same UX-redirect pattern
they already use for role mismatches), sending a suspended org's user to
a new `/subscription-suspended` page. Platform admins bypass both
checks everywhere, not just on the organizations panel itself.

**Real bug found and fixed during verification**: org zero's hand-picked
id (`00000000-0000-0000-0000-000000000001`, chosen back in the Phase 1
migration) isn't a real RFC 4122 UUID — Zod v4's strict `z.uuid()`
rejected it the moment it was submitted as form input, which would have
permanently blocked editing or suspending org zero specifically (any
other, normally-generated organization id would have been fine). Fixed
with a shape-only regex validator scoped to organization ids alone;
nothing else in the app was affected.

**Verified live in a real browser against the production database**, not
just typecheck/build — logged in as the real platform-admin account via
the same magic-link session-injection technique used in earlier sessions
(Playwright installed and removed again after, zero `package.json`/
lockfile diff). Confirmed: dashboard loads with no regression, the
Organizations page renders real data correctly, the self-suspend guard
actually blocks the action (verified via a direct DB read that nothing
changed and that no audit row was written for the blocked attempt), and
the edit dialog round-trips correctly (set a test value, reverted,
confirmed via direct DB read the final state exactly matches the
original, and via `audit_logs` that both changes are recorded with
correct old/new values). Zero console errors. `npm test`: 48/49, same
single pre-existing unrelated failure as every other pass today.

---

## 2026-09-14 (4)

**Migrations `20260723000031` and `20260723000032` (multi-tenant Phase 1 +
1B) applied to the live project via the Supabase CLI.** Owner asked to use
the CLI instead of the SQL editor. Blocked initially on two things, both
resolved: (1) no CLI auth in this environment (`supabase login` needs a
browser) — owner supplied a Personal Access Token, used only for this
session's CLI env var, never written to any file; (2) every prior
migration (`000001`–`000030`) had been applied by hand via the SQL editor,
so the CLI's own remote migration-history bookkeeping had zero record of
any of them — a plain `db push` would have tried to re-run all ~30 from
scratch and failed (or worse, partially executed a couple of
drop-then-recreate statements against live tables). Fixed by reconciling
history first: `supabase migration repair --status applied` for every
version through `000030` (updates only the CLI's bookkeeping table, runs
no SQL), verified after with `supabase migration list` that local/remote
now match. One migration's live status was checked directly rather than
assumed before repairing it as "applied": `approve_payment`'s signature
(migration `000024`) was probed with a safe bogus-id RPC call (fails on
its first check either way) to confirm the 3-arg form was actually live.
`db push --dry-run` then confirmed only `000031`/`000032` would run;
owner confirmed via AskUserQuestion before the real push. Both applied
cleanly, verified directly afterward: `organizations` has exactly one row
("xRush Agency"), the platform-admin account's `is_platform_admin` is
true, all 6 live clients backfilled to org zero, `total_outstanding_due`/
`all_client_dues` callable with the new `p_organization_id` param, old
unscoped signatures correctly gone from the schema cache. `CLAUDE.md`'s
Commands section updated: `supabase db push` can be used directly for
future migrations now that the CLI's history is reconciled, no local
install needed (`npx supabase ...`).

---

## 2026-09-14 (3)

**Multi-tenant subscription conversion — Phase 1B (server-layer org
scoping), migration NOT YET APPLIED to the live project.** The real
isolation layer, closing the gap Phase 1 (schema + RLS) flagged: since RLS
never runs in normal app usage (everything goes through the service-role
admin client), every read/write across all 23 `src/server/**/*.fns.ts`
files — plus `client-login.server.ts`, `notification.service.ts`,
`audit.service.ts`, `meta-sync.server.ts`, `spend-cap-sync.server.ts` —
now filters reads by `organization_id`, tags it on inserts, and validates
it before any update/delete that targets a row by id.

`SessionUser` gained `organizationId`/`isPlatformAdmin`, populated in
`loadSessionUser()` — every existing `requireAdmin()`/
`requireClientMembership()` caller gets them for free. New migration
`20260723000032_multi_tenant_rpc_scoping.sql`: 9 write RPCs that look up a
row by id gained a `p_organization_id` param, validated as an IDOR guard
before acting; 4 bulk aggregate RPCs (`total_outstanding_due`,
`all_client_dues`, `admin_today_totals`, `top_due_clients`) gained the
same param plus an internal filter, since they scan across all clients
with no per-row check otherwise.

**Two critical bugs found and fixed, not theoretical:**
1. `notifyAdmins()` fanned out to every admin across **every**
   organization with zero filter — any client's activity would have
   notified every other subscribing agency's admins too. Fixed with a
   required `organizationId` param; `notifyClientMembers()` needed no
   call-site changes since it now resolves the org from the client row
   itself.
2. The "Clear all data" button's fallback wipe path (`directWipe()`,
   used whenever the `reset_all_data()` RPC isn't installed — true right
   now, since neither pending migration is applied yet) had **its own,
   independent copy of the exact TRUNCATE-everything bug** already fixed
   in the RPC: no organization filter on any delete, and a storage
   cleanup step that emptied the **entire shared proofs bucket**, every
   organization's files. Right now, this fallback is the only working
   path (the RPC isn't live), so this was a live, reachable bug, not a
   hypothetical. Fixed: both scoped to the caller's own organization,
   storage paths captured before their owning rows are deleted. Also
   fixed incidentally: this fallback's table list had drifted out of
   sync with the RPC (missing `employees`/`client_employees`).
   Document-code sequences are shared across every organization, so
   neither reset path touches them anymore — correct, but a real,
   flagged behavior change from before.

**One earlier decision reversed, with reasoning**: Phase 1 said
`app_settings` (Meta credentials) would be scoped per-organization now.
Checking the actual runtime consumer, `getMetaConfig()`, showed it takes
zero parameters and is called from the unauthenticated daily cron —
making it org-aware is a real redesign (threading org through every Meta
API call site), not a query filter. Doing only half of it (a per-org
Settings screen over a still-single-tenant runtime) would have looked
like it worked and silently not. Left single-tenant, clearly flagged as a
dedicated follow-up. Per-account Meta actions already in scope here
(name sync, spend-cap push/apply/auto-sync) ARE correctly org-validated,
since each already operates on one specific, pre-checked account.

Also fixed along the way: `importMetaAdAccountsFn` wasn't setting
`organization_id` on newly-imported accounts at all (would have silently
defaulted every import to org zero); `provisionClientLogin()` (shared by
admin "Add login" and portal "Add teammate") now refuses to reuse an
existing login that belongs to a *different* organization, and correctly
sets a brand-new user's real org (the auth trigger defaults to org zero,
having no way to know better). `writeAudit()` gained a required
`organizationId` — 40 call sites across 14 files, 37 via a small
verified script, 3 system/cron sites by hand using the affected
account's own org.

`npm run typecheck` / `npm run build`: clean. `npm test`: 48/49, same
single pre-existing failure as Phase 1 (confirmed unrelated again).
**Owner must apply `20260723000032_multi_tenant_rpc_scoping.sql`**
alongside `20260723000031` — no DB connection available in this dev
environment.

Next: Phase 2 (super-admin panel) and Phase 3 (subscription-gate
enforcement) — not started.

---

## 2026-09-14 (2)

**Multi-tenant subscription conversion kicked off — Phase 1 of 4 (schema +
RLS foundation), migration NOT YET APPLIED to the live project.** Owner
wants to sell Rush Tracker as a subscription product to other agencies,
with fully isolated per-customer data and a manually-operated super-admin
panel to activate/suspend access (no payment gateway). Requested as 3
phases; became 4 after a finding surfaced before writing any SQL (see
below).

Before touching any code: read every migration, listed every table holding
"our agency"-scoped data (17: `clients`, `client_memberships`,
`ad_accounts`, `ad_account_assignments`, `limit_requests`,
`ledger_entries`, `attachments`, `payment_requests`, `payments`,
`adjustments`, `exchange_rates`, `employees`, `client_employees`,
`notifications`, `usd_margin_entries`, `audit_logs`, plus `user_profiles`),
and flagged three tables named in the request that don't actually exist
yet (`team_members`, `invites`, `funding_platforms`/`usd_purchases`/
`usd_treasury_ledger` — the latter a still-unbuilt, design-stage USD
purchase-tracking idea) rather than guessing at them.

Two decisions needed the owner's call before proceeding: (1) the new
cross-org access flag would have collided in name with the existing
per-organization `SUPER_ADMIN` role — resolved as `is_platform_admin`,
a distinct name, distinct concept (bypasses the subscription gate
entirely; the existing role stays subject to its own org's gate); (2)
`app_settings` (Meta integration credentials) is currently one global
value per key — resolved to scope it per-organization so each subscribing
agency can eventually plug in their own Meta Business Portfolio (not yet
built — tracked for Phase 1B).

**The finding that added a phase**: RLS in this app has never been the
real authorization layer — confirmed against this codebase's own
documented security rules and 23 real server-fn files — because virtually
every business read/write goes through `src/server/**/*.fns.ts` using the
service-role key, which bypasses RLS entirely. Schema + RLS alone would
give a working suspend/activate toggle and redirect, but would NOT stop
two simultaneously-*active* organizations from seeing each other's data
mixed together in every admin list/report, since none of those 23 files
filter by anything today. Surfaced to the owner before writing SQL; they
chose to fold "server-layer org scoping" in as an explicit Phase 1B ahead
of the super-admin panel (Phase 2) and access-gate enforcement (Phase 3).

**This pass (Phase 1 only)**: new `organizations` table, org zero seeded
("xRush Agency", fixed id), `organization_id` added to all 17 tables above
with a DB-level DEFAULT of org zero's id (safety net — every existing
insert keeps working until Phase 1B makes each one explicit; a fixed
literal was required anyway since Postgres doesn't allow subqueries in
DEFAULT expressions), `user_profiles.is_platform_admin` granted to
`mehedi.h.prantoz@gmail.com` (verified live: existing account, already
this org's `SUPER_ADMIN`), three new RLS helper functions
(`current_org_id()`, `is_org_active()`, `is_platform_admin()`) matching
the existing `is_admin()`/`is_client_member()` style, and every existing
SELECT policy on those 17 tables updated via `ALTER POLICY` to require an
organization + active-subscription match, OR'd with the platform-admin
bypass. `organizations` itself gets zero RLS policies for `authenticated`
(same treatment as `app_settings` — service-role-only). Manual rollback
documented as a comment block in the migration (Supabase's tooling has no
down-migration mechanism, matching this repo's existing convention).
`npm test`: 48/49 pass — the 1 failure is pre-existing (confirmed via
`git log`, predates this session, unrelated: a stale `SENSITIVE_PERMISSIONS`
test from the earlier Finance work). Typecheck/build unaffected (no app
code touched in this phase). **Owner must apply
`20260723000031_multi_tenant_foundation.sql`** via the SQL editor or
`supabase db push` — no DB connection/CLI available in this dev
environment (read-only service-role access was used beforehand to confirm
the target account and that `organizations` didn't already exist).

Next: Phase 1B (server-layer org scoping across the 23 `*.fns.ts` files —
the real isolation layer), then Phase 2 (super-admin panel) and Phase 3
(live subscription-gate enforcement) as originally scoped.

---

## 2026-09-14

**"Meta Due" summary added next to "Total Remaining", portal dashboard +
admin client detail page.** `listMyAccountsMetaRemainingFn`
(`meta.fns.ts`) now also returns `meta_balance` (Meta's `balance` field —
already surfaced elsewhere as "Meta Due") per account, alongside the
existing `remaining` figure — same underlying bulk Graph API fetch, no new
call. Also relaxed its per-row gate from requiring `spend_cap` to requiring
only a Meta account match (mirrors the admin-side `balanceByAccountId` fix
already documented in `CLAUDE.md`): an account can carry a Meta bill
balance with no spend cap set, and the old gate would have silently hidden
it. Portal dashboard (`portal/index.tsx`) sums this across the client's own
USD-currency linked accounts into a new "Meta Due" card, right after
"Total Remaining". Admin client detail page: `FinancialSummary`
(`components/shared/financial-summary.tsx`) gained a `totalMetaDueUsd`
prop/card, placed right after "Total Remaining"; `$clientId.tsx` computes
it the same way `totalRemainingUsd` already is, from the same
`balanceByAccountId` map the Ad Accounts tab's per-row Meta Due column
already builds — no new query. Both cards are USD-only (no FX path), same
gate as every other Meta-money aggregate in this app, and hide (rather than
show a misleading "$0.00") until the data resolves. `npm run typecheck` and
`npm run build` both pass.

---

## 2026-09-01

**New "Finance" section — USD buy/sell margin tracking (forex spread
revenue).** Built in two explicit steps at the owner's request. Step 1
(schema only): inspected the existing ledger/payments/employees/clients
tables first and flagged two real gaps before writing anything — no "buy
rate" exists anywhere in the prior schema (only the *sell* rate is
tracked, on `ledger_entries.usd_rate`), and the new `client_usd_rates`
history table is a separate thing from the existing live `clients.usd_rate`
scalar that real billing actually uses (nothing wires them together
automatically). Migration `20260723000026_finance_usd_margin.sql` adds
`client_usd_rates` and `usd_margin_entries` (the latter's `margin_bdt` is
DB-generated, `usd_amount * (sell_rate - buy_rate)`, never computed
client-side), both SELECT-only RLS, gated by two new sensitive permissions
(`finance.view`/`finance.manage`, SUPER_ADMIN-only by default). Applied by
the owner via the SQL editor; confirmed live afterward (both tables exist,
both permissions seeded, neither granted to ADMIN's role_permissions).

Step 2 (backend + UI, this pass): `src/server/finance/finance.fns.ts`
(list/create for both tables, audited), new `/admin/finance` page (nav
item added) with Margin Entries / Sell Rates tabs, create dialogs for
each, and a total-margin summary card. Insert-only from the UI (no
edit/delete), matching this app's broader financial-record convention.
`createClientUsdRateFn` auto-closes a client's prior open-ended rate the
day before a new one starts. Deliberately did not build a picker for
`usd_margin_entries.ledger_entry_id` (left optional/unset from this UI).
Does not touch `ledger_entries`, `payments`, `limit_requests`, or any Meta
spend-cap logic — purely additive. `npm run typecheck` and `npm run build`
both pass.

**Finance refined: added a real USD purchase ledger (cost-basis side) —
migration NOT YET APPLIED to the live project.** Owner asked to "recheck
and refine" the Finance idea into a "properly accounts solution." The
real gap in the first pass: `usd_margin_entries.buy_rate` was typed in
blind, with no record of what USD was actually bought for — a manual log,
not books of record. Asked the owner to choose the scope rather than
guessing given it conflicted with the original "don't touch existing
ledger" instruction; they chose the additive option (a purchase ledger)
over auto-generating margin entries from `approve_limit_request` (which
would have required touching that flow) or a reports-only pass.
New table `usd_purchases` (migration
`20260723000027_finance_usd_purchases.sql`, does not alter the already-
applied `20260723000026` tables): `purchase_date`, `usd_amount`,
`buy_rate`, `cost_bdt` (DB-generated), `source`, `note`,
`created_by → employees`. New `usd_inventory_summary()` SQL function
(same read-only-aggregate pattern as `client_financials()`) returns total
purchased, total sold (via `usd_margin_entries`), available balance, and
weighted-average cost across every purchase. Same SELECT-only RLS
convention, reuses the existing `finance.view`/`finance.manage`
permissions — no new permission needed.
Backend: `listUsdPurchasesFn`, `createUsdPurchaseFn`,
`getUsdInventorySummaryFn` in `finance.fns.ts`, audited as
`USD_PURCHASE_RECORDED`. UI: new "USD Purchases" tab on `/admin/finance`
with its own create dialog, plus two new stat cards ("Available USD
inventory", "Weighted-avg. cost") next to the existing margin total. The
margin-entry dialog now prefills `buy_rate` from the live weighted-average
cost (still editable — a specific sale can genuinely use a specific
batch) and shows a soft warning (not a hard block) when the USD amount
being sold exceeds what's actually available from recorded purchases —
deliberately not DB-enforced, since real purchase timing can lag a sale;
flagged as revisitable if the owner wants it strict. `npm run typecheck`
and `npm run build` both pass.

**`usd_purchases.purchase_date` now carries time-of-day, not just a date —
migration NOT YET APPLIED to the live project.** Owner asked to add time
to the date field on the purchase ledger. Checked first whether
`20260723000027` had already been applied (it had — table existed live,
empty), so this is a follow-up `alter column ... type timestamptz`
(`20260723000028_usd_purchases_datetime.sql`), not an edit to the
already-run file. Scoped to this one column only, matching the request —
`usd_margin_entries.transaction_date` and `client_usd_rates.effective_from/
effective_to` stay date-only. `CreatePurchaseDialog` now uses a
`datetime-local` input (converted to a real ISO timestamp on submit via
`new Date(...).toISOString()`, defaulted to the current local date/time);
the Purchases tab shows the recorded time alongside the date. `npm run
typecheck` and `npm run build` both pass.

**Finance rebuilt from scratch — the rate/inventory model was the wrong
concept.** Owner said the sell-rate history + USD purchase/inventory
design didn't match what they needed and asked to remake the whole board
around a simpler model: one entry per USD transaction — USD amount,
buying amount (total BDT paid), selling amount (total BDT received) —
margin is just selling minus buying, no rates. Also needed to see margin
totals grouped by 15 days / weekly / monthly / 6 months / yearly.
Checked live first: `client_usd_rates` and `usd_margin_entries` each held
exactly one row, matching the owner's own test values from trying out the
old design (not real data) — confirmed before dropping anything.
Migration `20260723000029_finance_rebuild.sql` drops `client_usd_rates`,
`usd_purchases`, and `usd_inventory_summary()` outright (not needed under
the new model), and drops + recreates `usd_margin_entries` with the new
shape: `transaction_date`, `usd_amount`, `buying_amount_bdt`,
`selling_amount_bdt`, `margin_bdt` (DB-generated, `selling - buying`).
No client link, no rates, no purchase ledger — exactly the 3 inputs
requested plus a date. `finance.view`/`finance.manage` permissions are
unchanged. Deleted the now-unneeded `create-client-rate-dialog.tsx` and
`create-purchase-dialog.tsx`; `finance.fns.ts` trimmed to just
`listUsdMarginEntriesFn`/`createUsdMarginEntryFn`; `create-margin-entry-
dialog.tsx` rewritten to the 3-field form with a live margin preview.
`/admin/finance` rebuilt as a single page (no more tabs — one entity now):
a total-margin card, a "Margin by period" table with a granularity
selector (15 Days / Weekly / Monthly / 6 Months / Yearly — client-side
grouping over the fetched list via decimal.js, no new query per
granularity), and the raw entry list below it. Bucket definitions are a
judgment call, flagged for the owner to correct if not what they meant:
15-day buckets are semi-monthly (1st–15th, 16th–end of month, common
payroll/billing convention) rather than a rolling 15-day window; weekly
buckets start Monday; 6-month buckets are calendar halves (Jan–Jun,
Jul–Dec). `npm run typecheck` and `npm run build` both pass. **Owner must
apply this migration** — no DB connection available in this dev
environment.

**Margin entry: added buying/selling rate inputs, amounts now
DB-computed — migration NOT YET APPLIED to the live project.** Owner
asked to put a rate field before each amount field, with the amount
auto-filled rather than typed. Checked live first (confirmed
`20260723000029` was already applied and the table still empty), so this
is another safe drop-and-recreate rather than an in-place edit.
`usd_margin_entries` gains `buying_rate`/`selling_rate` (real input
columns); `buying_amount_bdt`/`selling_amount_bdt` are now DB-generated
(`usd_amount * rate`, rounded) instead of typed directly.
`margin_bdt` is expressed straight from `usd_amount`/`buying_rate`/
`selling_rate` rather than from the two amount columns — Postgres doesn't
allow a generated column to reference another generated column.
`CreateMarginEntryDialog` now has Buying rate / Buying amount (disabled,
live-computed) and Selling rate / Selling amount (disabled, live-computed)
pairs, plus the existing margin preview — all computed client-side with
decimal.js and re-verified by the database's own generated columns on
save. `npm run typecheck` and `npm run build` both pass. **Owner must
apply this migration** — no DB connection available in this dev
environment.

**Payment dates now show time, on both admin and portal — no migration
needed.** Owner asked for exact time (e.g. "04:30 pm") on the admin
Payments list and the client portal's Due & Payments page. The underlying
column (`payments.created_at`) was already `timestamptz` — this was a
display-only gap, not a schema one. `admin/payments/index.tsx` and
`portal/due/index.tsx` both had a local date-only `fmtDate()`; replaced
with `fmtDateTime()` in each (same custom 12-hour formatter already used
elsewhere in this app for `fmtApprovalDateTime()` on the client detail
page's Limit Requests tab — zero-padded hour, lowercase am/pm), appended
after the date with a comma. Checked the admin payment detail page too —
it doesn't show a date at all, so nothing to change there. `npm run
typecheck` and `npm run build` both pass.

**"Notes" column added to both payment lists — no server change needed.**
Owner asked for admin_note to show in both the admin Payments list and
the portal Due & Payments list. Both `listPaymentsFn` (admin) and
`listMyPaymentsFn` (client, `payment.fns.ts`) already select `admin_note`/
`rejection_reason` — this was purely a missing display column, not a new
data exposure (the client-facing fn was already returning it to the
browser, just never rendered). New "Notes" column on both tables shows
`admin_note`, falling back to `rejection_reason` when a payment was
rejected with no separate note (matching the existing "the client will
see this reason" intent of the reject dialog) — truncated with
`max-w-xs truncate` like the Adjustments page's Reason column. `npm run
typecheck` and `npm run build` both pass.

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
