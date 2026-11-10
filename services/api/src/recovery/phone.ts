/**
 * Nigerian mobile numbers in the shape Supabase Auth stores them (auth.users.phone and
 * the JWT `phone` claim): country code + 10 digits, no '+', e.g. "2348034217765".
 * Accepts "+234 803 421 7765", "08034217765", "8034217765", "2348034217765".
 */
export function normalizeNgPhone(input: string): string | null {
  let d = input.replace(/\D/g, "");
  if (d.startsWith("234")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  return /^[789]\d{9}$/.test(d) ? `234${d}` : null;
}

/** "+234 803 ··· 7765" — enough to recognise your own number, not enough to read someone else's. */
export function maskPhone(stored: string): string {
  const d = stored.replace(/\D/g, "");
  return `+${d.slice(0, 3)} ${d.slice(3, 6)} ··· ${d.slice(-4)}`;
}

/** "Musa Abdullahi" → "M•••• A." — a recogniser, not a name to harvest. */
export function maskName(name: string | null | undefined): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0]!;
  const last = parts.length > 1 ? ` ${parts[parts.length - 1]![0]!.toUpperCase()}.` : "";
  return `${first[0]!.toUpperCase()}••••${last}`; // fixed width: no length hint
}

/** "musa.a@gmail.com" → "m•••a@gmail.com" (as 20j-recover-3-basic shows it). */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "•••";
  return `${user[0]}•••${user.length > 1 ? user[user.length - 1] : ""}@${domain}`;
}
