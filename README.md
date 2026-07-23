# Rush Tracker

Multi-client ad account limit, billing, due & payment management system for an
agency. Full specification: [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md)
(source of truth). Agent/contributor conventions: [CLAUDE.md](CLAUDE.md).

## Stack

- **TanStack Start + TanStack Router** (React 19, TypeScript strict, Vite 8)
- **Supabase** — PostgreSQL, Auth, Storage (all business operations go through
  the TanStack Start server layer)
- **Tailwind CSS v4 + shadcn/ui + Lucide**
- **Deployment** — Vercel serverless via Nitro v3 (preset auto-detected on
  Vercel builds)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** (or `supabase start` for local dev), then
   apply the migrations in `supabase/migrations/` — with the Supabase CLI:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   (or paste each migration into the SQL editor in order).

3. **Configure environment** — copy `.env.example` to `.env` and fill in your
   project URL, anon key, and service-role key. The service-role key is
   server-only: never give it a `VITE_` prefix.

4. **Create the first admin user** — add a user in Supabase Dashboard →
   Authentication (the trigger creates a CLIENT profile automatically), then
   promote them using the snippet in `supabase/seed.sql`.

5. **Run**

   ```bash
   npm run dev        # http://localhost:3000
   npm run typecheck
   npm run build
   ```

## Deploying to Vercel

Import the repo in Vercel and set the three environment variables
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
Nitro detects Vercel automatically and emits serverless functions — no extra
configuration required.

## Project status

Phase 1 (foundation: auth, RBAC, layouts, route protection, base schema) is
complete. See the phase plan in `docs/PROJECT_SPEC.md` §84.
