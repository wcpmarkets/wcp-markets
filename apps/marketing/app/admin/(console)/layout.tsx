import Link from "next/link";
import { adminApi, type AdminRecovery, type DisputeQueueItem, type HeldListing, type ReportQueueItem } from "@/lib/admin";
import { adminLogout } from "../actions";
import { NavLink } from "./nav-link";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [d, r, rc, h] = await Promise.all([
    adminApi<DisputeQueueItem[]>("/admin/disputes"),
    adminApi<ReportQueueItem[]>("/admin/reports?limit=100"),
    adminApi<AdminRecovery[]>("/admin/recoveries"),
    adminApi<HeldListing[]>("/admin/listings/held?limit=100"),
  ]);
  const n = (x: { ok: boolean; data?: unknown[] }) => (x.ok ? (x as { data: unknown[] }).data.length : null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/admin" className="font-bold">WCP · Staff</Link>
          <nav className="flex flex-wrap gap-1 text-sm">
            <NavLink href="/admin/disputes" count={n(d)}>Disputes</NavLink>
            <NavLink href="/admin/reports" count={n(r)}>Reports</NavLink>
            <NavLink href="/admin/held" count={n(h)}>Held listings</NavLink>
            <NavLink href="/admin/recoveries" count={n(rc)}>Recoveries</NavLink>
          </nav>
          <form action={adminLogout} className="ml-auto">
            <button className="text-sm text-muted hover:text-ink">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
