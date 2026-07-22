# WCP Markets — backend + marketing site

Turborepo: `apps/marketing` (Next.js), `services/api` (Hono on ARM64 Lambda),
`packages/*`, `supabase/migrations`, `infra` (Terraform, eu-west-1).
See `README.md` for layout and stack, and the phased plan for rationale.

## Deploying

```bash
pnpm deploy      # builds all three Lambda bundles, then terraform apply
```

**Never run `terraform apply` on its own.** Terraform zips whatever is already in
`services/api/dist/` — it does not build. Applying without building first ships
whatever bundle was last compiled, which looks like a successful deploy and
silently serves stale code. This has already caused one wrong bug report.

Migrations are applied ad-hoc, not by Terraform, and there is no migration state
table — check whether a migration has already run before re-running it:

```bash
cd services/api && npx tsx scripts/apply-sql.ts ../../supabase/migrations/00NN_x.sql
```

## Contract-first

`contracts/openapi.json` is emitted from the Hono app and **committed**. Clients
generate from the committed artifact, not from live code.

```bash
pnpm gen    # openapi.json + deal-guard SQL + packages/api-client
```

CI fails on undiffed drift, so run this after any route or schema change and
commit both the contract and the generated client. `packages/api-client/src/schema.ts`
is generated — never hand-edit.

Zod schemas need `.openapi("Name")`: inline/anonymous schemas generate unusable
Kotlin and Swift clients.

## Things that bite

- **Money is integer minor units (kobo), never floats.** `bigint` in Postgres,
  arriving as a string from postgres.js — `Number()` it at the boundary.
- **Invariants live in SQL constraints, not RLS.** The API uses the service role
  and bypasses RLS entirely. RLS still matters for the read path, where clients
  subscribe to Supabase directly — it's the only thing between two users' private
  negotiations, so treat it as load-bearing, not defence in depth.
- **The deal state machine is generated into a Postgres guard** from one TS map.
  Don't hand-mirror transitions in SQL; regenerate.
- **`services/api/src/data/ng-regions.ts` is the source of truth for locations**,
  and the Android app carries a generated copy for offline use. Changing it
  without regenerating that copy makes the app's picker disagree with the server
  whenever the network is down. See the note in the file.
- **Never commit secrets.** Supabase service-role key, JWT secret, pooler
  `DATABASE_URL` and AWS keys live in SSM only; scripts read them from there.
  Don't echo them into logs or chat.

## Verifying

Prefer hitting the deployed API over reasoning about the code:

```bash
curl -s "$API/listings?state=Lagos&city=Yaba"
curl -s "$API/listings/facets"
```

`services/api/scripts/test-cloud-*.ts` cover the money paths end-to-end.
