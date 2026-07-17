# WCP

Monorepo for the **WCP Markets** platform — an AI-native, escrow-backed classifieds
marketplace for Nigeria (Goods · Property · Vehicles · Services).

Built in phases; **Phase 1 = the marketing & waitlist site** (`apps/marketing`),
constructed as the foundation of the eventual web app. See the full build plan at
`~/.claude/plans/how-should-we-build-modular-thunder.md`.

## Structure

```
apps/
  marketing/   # Phase 1 — Next.js marketing + waitlist site
packages/
  config/      # shared eslint / ts / tailwind presets
  tokens/      # design tokens (colors, gradients, type) → CSS vars + Tailwind theme
  ui/          # shared React component library
  analytics/   # track() abstraction
services/      # (Phase 2) AWS Lambda handlers: money, ai, webhooks, workers
```

## Getting started

```bash
pnpm install
pnpm dev        # runs apps/marketing at http://localhost:3000
pnpm build
pnpm typecheck
```

## Stack (see plan for rationale)

- **Web:** Next.js 15 (App Router) + React 19 + TypeScript + Tailwind, on Vercel.
- **Backend core (Phase 2):** Supabase (Postgres + Auth + Realtime + Storage).
- **Compute (Phase 2):** AWS Lambda + SQS; Terraform IaC; serverless / scale-to-zero.
- **Mobile (Phase 2):** native iOS (Swift/SwiftUI) + Android (Kotlin/Compose) over a
  contract-first OpenAPI API.

`design_handoff_marketing_site/` holds the original design references (source of
truth for Phase-1 pixels/copy) — not production code.
