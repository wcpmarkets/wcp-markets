"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, count, children }: { href: string; count: number | null; children: React.ReactNode }) {
  const active = usePathname().startsWith(href);
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 ${active ? "bg-panel text-ink" : "text-muted hover:text-ink"}`}
    >
      {children}
      {count != null && (
        <span className={`ml-1.5 rounded-full px-1.5 text-xs ${count > 0 ? "bg-brand-purple/30 text-ink" : "text-faint"}`}>{count}</span>
      )}
    </Link>
  );
}
