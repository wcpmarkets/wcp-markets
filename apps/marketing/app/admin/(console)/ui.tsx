import type { UserSummary } from "@/lib/admin";
import { who } from "@/lib/admin";

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">{children}</p>;
}

export function Failed({ error }: { error: string }) {
  return (
    <p role="alert" className="rounded-xl border border-[#e5645a]/40 bg-[#e5645a]/10 px-4 py-3 text-sm">
      Couldn&apos;t load this ({error}). Reload to try again.
    </p>
  );
}

export function Person({ u, role, extra }: { u: UserSummary; role: string; extra?: React.ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-xs uppercase tracking-wide text-faint">{role}</span>
      <span className="font-medium">{who(u)}</span>
      {u.verified && <span title="ID verified" className="text-brand-cyan">✓</span>}
      {extra}
    </span>
  );
}

export function Chip({ tone = "muted", children }: { tone?: "muted" | "warn" | "danger" | "ok"; children: React.ReactNode }) {
  const c = {
    muted: "border-line text-muted",
    warn: "border-[#ffb020]/50 text-[#ffb020]",
    danger: "border-[#e5645a]/50 text-[#e5645a]",
    ok: "border-lime/50 text-lime",
  }[tone];
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${c}`}>{children}</span>;
}
