import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Centered content column — `max-width: 1140px` with `32px` horizontal gutters,
 * the standard container from the design handoff.
 */
export function Container({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1140px] px-8", className)}>
      {children}
    </div>
  );
}
