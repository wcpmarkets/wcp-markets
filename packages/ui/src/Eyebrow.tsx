import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Section eyebrow — 11px/700, `.14em` tracking, brand purple. Used above every
 * section heading ("ONE APP · FOUR LANES", "THE TRUST ENGINE", …).
 */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-[11px] font-bold tracking-[0.14em] text-brand-purple",
        className,
      )}
    >
      {children}
    </div>
  );
}
