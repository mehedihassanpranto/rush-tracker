# Rush Tracker — Deploying to Hostinger

**This is the production deployment** (`panel.xrush.online`, Hostinger account
`u835379012`). `docs/DEPLOYMENT.md` is the older Vercel guide, kept for its
environment-variable notes and verification checklist. Nothing in the repo is
Hostinger-specific at build time — see "Why no config switch is needed" at the
bottom.

Everything below was verified against a real production build of this repo, not
inferred from documentation.

---

## 0. Before you start — what the plan must support

**This will not run on Hostinger's shared PHP/Apache hosting.** You need their
Node.js application hosting (the tier whose supported-framework list names
Nitro).

| Requirement | Value | Why |
| --- | --- | --- |
| Runtime | **Node.js ≥ 22.12** | `@tanstack/react-start` declares `>=22.12.0`. Vite and Nitro would accept 20.19, but react-start is the binding constraint — **Node 20 will fail.** Pinned in `package.json` `engines` and `.nvmrc`. |
| Process type | Long-running Node process | Not PHP, not CGI. The app is an HTTP server. |
| Persistent disk | **Not needed** | The server writes nothing to local disk; proof files live in Supabase Storage. The app is stateless, so restarts and redeploys lose nothing. |
| Outbound HTTPS | Required | Supabase, Meta Graph API, Telegram. |
| Cron | Needed for the daily job | See §5. Without it the Meta sync silently stops. |

When Hostinger support asks what framework this is, the answer is **Nitro** —
that is what the project builds into, and it is on their supported list under
both Frontend and Backend.

**Do not say "React Router".** Their list includes React Router (the framework
formerly called Remix); this project uses **TanStack Router**, an unrelated
library with a confusingly similar name. `react-router` is not installed at all.

---

## 1. Repository

Hostinger pulls from GitHub:

```
https://github.com/mehedihassanpranto/rush-tracker   (branch: main)
```

Anything not committed and pushed does not exist as far as the deploy is
concerned. Check before every deploy:

```bash
git status --porcelain     # expect no output
git log --oneline -1       # compare against origin/main
```

---

## 2. Build and start commands

| Setting | Value |
| --- | --- |
| Install | `npm ci` |
| Build | `npm run build` |
| Start | `npm start` (→ `node .output/server/index.mjs`) |
| Port | Read from `PORT`, injected by Hostinger — do not hardcode |

`npm start` exists for exactly this purpose and matches the command Nitro itself
records in `.output/nitro.json`. Build output is ~5.6 MB and self-contained;
`.output/public/` (static assets) is served by the same Node process, so no
separate web-root or document-root setting is required.

---

## 3. Environment variables

Set these in Hostinger's environment/variables panel. Same list as the Vercel
deploy — see `docs/DEPLOYMENT.md` §2 for the full notes on each.

| Variable | Required | Exposure |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Public |
| `VITE_SUPABASE_ANON_KEY` | yes | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Server only** |
| `CRON_SECRET` | yes, in practice | **Server only** |
| `META_SYSTEM_USER_TOKEN` | optional | **Server only** |
| `META_BUSINESS_ID` | optional | **Server only** |
| `META_API_VERSION` | optional (default `v21.0`) | **Server only** |
| `TELEGRAM_BOT_TOKEN` | optional — the SHARED bot (agency + client) | **Server only** |
| `TELEGRAM_PLATFORM_BOT_TOKEN` | optional — a SEPARATE bot, platform admins only | **Server only** |
| `TELEGRAM_WEBHOOK_SECRET` | optional, but required for linking to work on either bot | **Server only** |
| `TELEGRAM_CHAT_ID` | optional, legacy — only used by "Import legacy chat" (shared bot) | **Server only** |

### ⚠ Set these BEFORE the first build, or you get a silent broken deploy

**This is the single most likely way to lose an afternoon here, and it was
confirmed by testing, not guessed.** Building with the `VITE_` variables unset:

- the build **succeeds**, exit code 0, no warning of any kind
- the client bundle is compiled with `undefined` where the Supabase URL belongs
- **every page then returns HTTP 500** at run time

Because `VITE_` variables are baked in at build time, setting them afterwards
and **restarting does not fix it** — the broken values are already inside the
bundle. You must trigger a **rebuild**.

So: set the environment variables in Hostinger's panel *first*, then run the
first deploy. If you have already deployed and are seeing 500s on every page,
this is almost certainly why — set the vars and redeploy rather than debugging
the app.

### Three more things that bite

1. **`VITE_`-prefixed variables are read at BUILD time, not run time** (see
   above). The server-only ones are read at run time and take effect on a plain
   restart.
2. **Never prefix `SUPABASE_SERVICE_ROLE_KEY` with `VITE_`.** That would publish
   your service-role key to every visitor's browser.
3. `CRON_SECRET` is marked optional by the schema, but without it the cron
   endpoint returns 503 and the daily job never runs. On Vercel this header was
   injected automatically; **on Hostinger nothing injects it — you must set it
   and send it yourself** (§5).

The `META_*` variables are the **platform's** credentials (they point at the
Business Portfolio holding the platform ad-account pool), not any one agency's.
They can also be managed live from Platform → Settings without a redeploy.

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_PLATFORM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`
are server-only, so — unlike the `VITE_` variables — setting or changing them
only needs a **restart**, not a rebuild. The two bots are independent and each
needs its own **Register webhook** click on Platform → Settings (one card per
bot): the shared bot calls `https://yourdomain/api/telegram/webhook`, the
platform bot calls `https://yourdomain/api/telegram/webhook/platform`. Only
set up the ones you actually have a token for — either can be configured
without the other.

---

## 4. Supabase configuration

Supabase is unaffected by the move — it is already hosted and stays where it is.
But it must be told about the new origin, or **login will break in ways that look
like an app bug**:

Supabase Dashboard → Authentication → URL Configuration:

- **Site URL** → your Hostinger domain (`https://yourdomain`)
- **Redirect URLs** → add `https://yourdomain/**`

Until this is done, magic links and password-reset links keep sending users to
the old domain. If you run both deploys in parallel, list **both** origins.

No database migration is needed. The schema is already live.

### Auth emails — SMTP, sender domain, templates

Password-reset and email-change emails are sent by Supabase through the
Hostinger mailbox `no-reply@panel.xrush.online` (set 2026-10-03). Supabase's
built-in mailer only reaches the project's own team, so without this, emails
never reach agency staff or clients.

- **SMTP** (Authentication → Emails → SMTP settings): host `smtp.hostinger.com`,
  port `465`, user and sender `no-reply@panel.xrush.online`, sender name
  "Rush Tracker". Email rate limit: 30/hour. Staging uses the same mailbox
  with sender name "Rush Tracker (staging)".
- **DNS** — `panel.xrush.online` is its **own DNS zone** at Hostinger, so its
  mail records must be in that zone, not in `xrush.online`'s (records named
  `….panel` there are never served). It has MX, SPF and the three DKIM CNAMEs
  `hostingermail-{a,b,c}._domainkey` → `hostingermail-{a,b,c}.dkim.mail.hostinger.com`.
  DMARC falls back to `_dmarc.xrush.online` (`p=none`).
- **"Change email address" template** — must link to the app, not to
  `{{ .ConfirmationURL }}` (that URL signs in whoever clicks it):
  `{{ .SiteURL }}/confirm-email?token_hash={{ .TokenHash }}`. "Secure email
  change" stays ON (both the old and the new address must confirm), and the
  "Email address changed" notice to the old address is ON. Custom templates
  need custom SMTP on the free plan.
- **Site URL** must be `https://panel.xrush.online` — the template builds links
  from it.

---

## 5. The daily cron job — the one thing that does not carry over

The daily job is **not** part of the deploy — it has to exist as a cron entry in
the hosting panel. Without it nothing fails loudly; the job simply never runs,
and these stop happening:

- Meta ad-account name syncs
- "account disabled" and low-balance alerts
- retries of failed spend-cap pushes after an approval

Recreate it in Hostinger's cron panel:

```
0 3 * * *  curl -fsS -H "Authorization: Bearer YOUR_CRON_SECRET" https://yourdomain/api/cron/meta-sync
```

`-f` makes curl exit non-zero on an HTTP error, so a failure shows up in the
cron log instead of passing silently. Confirm what timezone Hostinger's cron
uses (System health's "Last success" time shows it after the first run) and
adjust if you want a specific hour.

**Production's entry (created 2026-10-03, uid `T9jasSyGe0`):**
`0 3 * * *  curl -sS -m 300 -o /dev/null -w "meta-sync HTTP %{http_code}" -H "Authorization: Bearer <CRON_SECRET>" https://panel.xrush.online/api/cron/meta-sync`
— listed under hPanel → Advanced → Cron Jobs (or via the Hostinger API's
`hosting_cron-jobs_list`). Before this date the job only ran because the old
Vercel project's cron was still calling it; it stopped when that did, and
System health caught it on its first day.

Verify by hand after deploying:

```bash
# expect 401 — proves the endpoint is reachable and the guard works
curl -s -o /dev/null -w '%{http_code}\n' https://yourdomain/api/cron/meta-sync

# expect 200 and a JSON run summary
curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" https://yourdomain/api/cron/meta-sync
```

The endpoint is idempotent — running it twice is safe.

**Ongoing check: Platform → System health.** Every run is recorded, so that
page shows the last successful run and turns red ("Stale") when there hasn't
been one for 26 hours — the signal that the cron entry is missing or broken.
A run that fails (fully or partly) is also sent to platform admins in-app and on
the platform Telegram bot. If the page says recent runs came from more than one
host, two schedulers are calling the job — remove the extra one.

---

## 6. Post-deploy verification

Run `docs/DEPLOYMENT.md` §6's full checklist. The Hostinger-specific additions:

- [ ] `/login` returns **200**, not 500. A 500 on every page means the build ran
      without the `VITE_` variables — set them and rebuild (see §3).
- [ ] Signing in as an agency admin lands on `/agency`; a client on `/client`; a
      platform admin on `/platform`. (Wrong-area attempts should redirect, not 404.)
- [ ] A static asset under `/assets/` returns 200 — confirms the Node process is
      serving `.output/public`.
- [ ] `/api/cron/meta-sync` returns **401** without the header (not 404 — 404
      means the build did not include the route; not 503 — that means
      `CRON_SECRET` is unset).
- [ ] The Meta-dependent columns (Remaining, Meta Due) populate on
      `/agency/ad-accounts` — confirms outbound HTTPS to Meta works from
      Hostinger's network.
- [ ] Restart the app and confirm sessions survive — they live in cookies backed
      by Supabase, not in process memory.

---

## 7. Why no config switch is needed

The build auto-selects its output format:

- On Hostinger (and any host without the `VERCEL` env var) Nitro emits
  **`node-server`**: a plain Node HTTP server at `.output/server/index.mjs`,
  listening on `PORT`. (It would emit the `vercel` preset only if `VERCEL` were
  set at build time.)

Confirmed on a real build
here: preset `node-server`, no `.vercel` directory and no serverless functions
emitted, `npm start` serving `/login` with a 200 and auth redirects intact.
