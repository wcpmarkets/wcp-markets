# Supabase — WCP

Backend core for the platform. In **Phase 1** it stores only the marketing-site
**waitlist**. Auth, listings, chat, storage, etc. come in Phase 2.

## One-time setup for the waitlist

1. **Create a project** at [supabase.com](https://supabase.com/dashboard) →
   *New project*. Pick a region close to Nigeria (e.g. `West EU (London)` or
   `East US` — Supabase has no African region yet). Save the database password.

2. **Create the table.** In the dashboard → **SQL Editor** → *New query*, paste
   the contents of [`migrations/0001_waitlist.sql`](./migrations/0001_waitlist.sql)
   and click **Run**. (Or use the Supabase CLI: `supabase db push`.)

3. **Grab the credentials.** Dashboard → **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL`
   - **`service_role` secret key** (under *Project API keys*) →
     `SUPABASE_SERVICE_ROLE_KEY`
     ⚠️ This key bypasses RLS. It is used **server-side only** (the waitlist
     server action imports `server-only`). **Never** prefix it with
     `NEXT_PUBLIC_` and never expose it to the browser.

## Where the keys go

- **Local dev:** create `apps/marketing/.env.local` (gitignored):

  ```
  SUPABASE_URL=https://<your-project-ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
  ```

  Restart `pnpm dev`. The waitlist now writes to Postgres instead of the local
  `data/waitlist.json` fallback.

- **Vercel:** Project → **Settings → Environment Variables** → add the same two
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) for **Production** (and Preview),
  then redeploy.

## How it's wired

`apps/marketing/lib/waitlist.ts` is the single storage seam: if `SUPABASE_URL`
+ a key are set it inserts into `public.waitlist`; otherwise it falls back to a
local JSON file. Duplicate emails are treated as success (idempotent).
