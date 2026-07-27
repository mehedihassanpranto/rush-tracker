# Rush Tracker — Deployment (Phase 8)

Target: **Vercel serverless** via Nitro v3 (spec deployment target). Nitro
auto-selects its `vercel` preset when the `VERCEL` environment variable is
present at build time (Vercel sets it automatically), emitting the Vercel Build
Output API directory — **no `vercel.json` or extra preset config is required**.
Local `npm run build` uses the `node-server` preset instead.

---

## 1. Prerequisites

- A Supabase project with **all seven migrations applied in order**
  (`supabase/migrations/20260723000001…07`), via the Supabase CLI
  (`supabase db push`) or the SQL editor.
- The private `proofs` Storage bucket exists (created in the Phase 3 migration /
  setup) and is **not public**.
- At least one SUPER_ADMIN user promoted (see `supabase/seed.sql`).

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

Set these for **Production** (and Preview if you use it):

| Variable | Value | Exposure |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` | Public (browser + server) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role/secret key | **Server only** |

Notes:
- The server env loader (`env.server.ts`) reads `SUPABASE_URL` / `SUPABASE_ANON_KEY`
  but falls back to the `VITE_`-prefixed values, so the three variables above are
  sufficient. You may optionally also set non-prefixed `SUPABASE_URL` /
  `SUPABASE_ANON_KEY`.
- **Never** give the service-role key a `VITE_` prefix — that would bundle it
  into the browser. It is validated as server-only at runtime (`getServerEnv()`
  throws if called in the browser).
- If the service-role key was ever exposed, rotate it in Supabase and update the
  Vercel value.

## 3. Vercel project settings

- **Framework Preset:** Other (a custom Vite + Nitro build).
- **Build Command:** `npm run build` (Vercel default works too).
- **Install Command:** `npm install`.
- **Output Directory:** leave default — Nitro's vercel preset writes the Build
  Output API directory, which Vercel detects automatically.
- **Node version:** 20+ (project is developed on 22/24).
- **Function region:** `vercel.json` pins serverless functions to `sin1`
  (Singapore) to sit next to the Supabase project (ap-southeast-1). Keep this in
  sync with the Supabase region — a mismatch makes every DB round trip
  cross-region and is the single biggest source of slow page loads. (This is the
  only reason a `vercel.json` exists; the preset itself needs no config.)

## 4. Supabase Auth redirect / URL config

In Supabase → Authentication → URL Configuration, add the production origin
(`https://<your-domain>`) to the allowed redirect URLs so login/logout and
session cookies work on the deployed domain.

## 5. Deploy

Push to the connected Git branch (or `vercel --prod`). Vercel runs the build;
Nitro emits serverless functions for the server routes and static assets for the
client bundle.

---

## 6. Production verification checklist

Run against the deployed URL right after the first deploy:

- [ ] **App loads** and unauthenticated `/admin` and `/portal` redirect to
      `/login` (guards active); `/login` returns 200.
- [ ] **Auth round-trip:** log in as SUPER_ADMIN → lands on `/admin`; log in as
      a CLIENT → lands on `/portal`. Logout clears the session.
- [ ] **Server function cold start:** the admin dashboard loads its live cards
      (this exercises a service-role query through a serverless function).
- [ ] **Env wiring:** no "Invalid server environment configuration" error in the
      Vercel function logs (means the three env vars are set correctly).
- [ ] **Write path:** create a test client, then an ad account, assign it — all
      succeed and appear (service-role writes + audit).
- [ ] **Financial path:** submit and approve a small limit request; confirm the
      ledger row and due update; the "Today's" dashboard cards reflect it
      (Asia/Dhaka business day).
- [ ] **Proof signing:** upload a limit-approval proof and open it — a fresh
      60-second signed URL loads; a stale one 403s. The `proofs` bucket is not
      publicly listable.
- [ ] **Notifications:** the client submitting a request produces an admin
      notification (bell badge increments).
- [ ] **Reports/CSV:** open Reports, export a CSV, confirm it downloads and the
      ৳ symbol renders (UTF-8 BOM).
- [ ] **Reconciliation:** run the queries in `docs/TESTING.md §3` — all return 0
      rows.
- [ ] **Secret check:** view page source / network on the client — the
      service-role key never appears; only the anon key does.

## 7. Post-deploy operations

- Apply new migrations to the production database **before** deploying code that
  depends on them.
- Keep the "no write RLS policies; all writes via guarded server fns" invariant
  (see `docs/SECURITY_REVIEW.md`).
- `npm test`, `npm run typecheck`, and `npm run build` should all pass in CI
  before promoting a build.
