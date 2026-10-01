# Staging environment

Production verification used to run through the real UI against the real
database, which caused two incidents (a revoked grant on `ADA-0006`, and a
`reset_all_data()` wipe). Everything destructive now goes to a separate,
disposable Supabase project.

## One-time setup

1. Create a new Supabase project (free tier is fine), e.g. `rush-tracker-staging`.
2. Link and push every migration:
   ```
   export SUPABASE_ACCESS_TOKEN=...
   npx supabase link --project-ref <staging-ref>
   npx supabase db push
   ```
   (`supabase/.temp` holds the link; it is gitignored. Re-link to the
   production ref before any production `db push`, and check with
   `npx supabase projects list` which one is linked.)
3. Create the storage bucket the app expects: a **private** bucket named `proofs`.
4. Copy `.env.test.example` to `.env.test` and fill in the staging URL, anon key
   and service-role key.
5. Optional, for running the app/Playwright against staging: copy the same
   values into `.env.staging` and start with
   `npx vite dev --port 3000 --mode staging`.

## Running the live tests

```
npm run test:live
```

`src/test/live-env.ts` reads `.env.test` (or `SUPABASE_TEST_URL`,
`SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY` in CI). It never
reads `.env`, and throws if the URL matches `.env`'s. With no credentials the
live suites skip, so plain `npm test` stays green anywhere.

## Rules

- Never put production keys in `.env.test` / `.env.staging`.
- Browser verification (Playwright + magic-link) targets staging only.
- Staging may be wiped and re-pushed at any time; nothing there is precious.

## End-to-end tests

`npm run test:e2e` runs Playwright (`e2e/`) against a dev server on port 3100
wired to the staging project. `global-setup` seeds throwaway agencies, logins
and a suspended agency (`ZZ E2E …`, fixed names, deleted by `global-teardown`),
signs each in with a password and saves the session cookies. The server is
started with the production Meta/Telegram/cron secrets overridden by inert
values, so it cannot reach the real Business Portfolio or bots even though
`.env` holds them. Covered: role routing, cross-agency isolation, the suspended
page, and every sidebar link of all three areas loading without a page error.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR:
migration-file check, typecheck, build, `npm test` (unit + live-DB), then e2e.
Needs the repository secrets `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`,
`SUPABASE_TEST_SERVICE_ROLE_KEY` (staging values); without them the live and
e2e steps skip rather than fail.

Recommended GitHub setting (Settings → Branches → add rule for `main`):
*Require a pull request* and *Require status checks to pass* with
"Typecheck, build, tests" selected.

## Commit habit

Commit and push the same day you make a change. The Finance & Accounts code was
once nearly lost because it sat uncommitted on a different machine.
