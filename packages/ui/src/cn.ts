/** Tiny className joiner — drops falsy values. Keeps @wcp/ui dependency-free. */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
