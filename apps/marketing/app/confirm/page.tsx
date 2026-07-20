import Link from "next/link";
import { confirmWaitlistEntry, type ConfirmResult } from "@/lib/waitlist";

export const metadata = { title: "Confirm your waitlist signup — WCP Markets" };
// The token varies per request; never cache the confirm outcome.
export const dynamic = "force-dynamic";

const COPY: Record<
  ConfirmResult["status"],
  { icon: string; iconClass: string; heading: string; body: string }
> = {
  confirmed: {
    icon: "✓",
    iconClass: "text-brand-cyan",
    heading: "You’re confirmed.",
    body: "Your spot on the WCP Markets waitlist is locked in. We’ll email you the moment your city opens — and verified-seller onboarding before the crowd arrives.",
  },
  already: {
    icon: "✓",
    iconClass: "text-brand-cyan",
    heading: "Already confirmed.",
    body: "This email is already on the list — nothing more to do. See you at launch.",
  },
  invalid: {
    icon: "!",
    iconClass: "text-lane-vehicles",
    heading: "This link isn’t valid.",
    body: "The confirmation link is invalid or has expired. Try joining the waitlist again to get a fresh link.",
  },
  error: {
    icon: "!",
    iconClass: "text-lane-vehicles",
    heading: "Something went wrong.",
    body: "We couldn’t confirm your signup just now. Please try the link again in a moment.",
  },
};

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token ? await confirmWaitlistEntry(token) : { status: "invalid" as const };
  const copy = COPY[result.status];

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-16">
      <div className="w-full max-w-[460px] rounded-2xl border border-line bg-panel p-8 text-center sm:p-10">
        <div
          className={`mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full border border-line text-[22px] font-bold ${copy.iconClass}`}
          aria-hidden="true"
        >
          {copy.icon}
        </div>
        <h1 className="text-[24px] font-bold leading-tight text-ink">{copy.heading}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">{copy.body}</p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-[10px] bg-gradient-to-r from-brand-purple to-brand-cyan px-6 py-3 text-[14.5px] font-bold text-canvas-alt"
        >
          Back to WCP Markets
        </Link>
      </div>
    </main>
  );
}
