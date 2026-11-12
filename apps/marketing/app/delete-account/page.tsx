import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Container } from "@wcp/ui";
import { Footer } from "@/components/Footer";
import { DeleteAccountForm } from "@/components/DeleteAccountForm";

export const metadata: Metadata = {
  title: "Delete your account — WCP Markets",
  description: "How to delete your WCP Markets account and what happens to your data.",
};

/** Play's "web link to request account deletion". The app has the same in Privacy & security. */
export default function DeleteAccountPage() {
  return (
    <>
      <header className="border-b border-divider">
        <Container className="flex items-center py-[22px]">
          <Link href="/" className="flex items-center gap-2" aria-label="WCP Markets — home">
            <Image src="/wcp-logomark.png" alt="" width={1306} height={1439} className="h-7 w-auto shrink-0 object-contain" />
            <span className="text-[18px] font-bold tracking-[-0.3px] text-ink">WCP Markets</span>
          </Link>
        </Container>
      </header>

      <main>
        <Container className="max-w-[760px] py-16">
          <h1 className="text-[34px] font-bold tracking-[-1px]">Delete your account</h1>

          <p className="mt-6 text-[15px] leading-[1.7] text-muted">
            In the app: <b className="text-ink-secondary">Account → Privacy &amp; security → Delete my account</b>.
            Or do it here — we&apos;ll text a code to the phone number on your account to confirm it&apos;s you.
          </p>

          <div className="mt-8">
            <DeleteAccountForm />
          </div>

          <Section title="What gets deleted">
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>Your name, store name, bio, photo, area and phone number on your profile.</li>
              <li>Your listings that haven&apos;t sold, and their photos.</li>
              <li>Saved items, price watches, notifications, saved addresses, your payout bank account and receipt email.</li>
              <li>Your identity-verification selfie.</li>
              <li>Your sign-in: every device is signed out, and the account can&apos;t be used again.</li>
            </ul>
          </Section>

          <Section title="What we keep, without your name">
            <p className="mt-3">
              Records of completed deals, payments, payouts, reviews and disputes are financial
              records we&apos;re required to keep, and the other person in each deal still needs
              them. They stay, shown as &quot;Deleted user&quot;. Messages you sent stay in the other
              person&apos;s conversation. If you verified your identity, we keep the result of that
              check (never your BVN or NIN itself) for regulatory record-keeping.
            </p>
          </Section>

          <Section title="When you can't delete yet">
            <p className="mt-3">
              While a deal is open or a payout is on its way, money is held in escrow for you or
              the other person, so the account has to stay until it finishes. The page above tells
              you which ones.
            </p>
          </Section>

          <Section title="Can't receive the code?">
            <p className="mt-3">
              If you no longer have the phone number, email{" "}
              <a href="mailto:cx@wcpmarkets.com">cx@wcpmarkets.com</a> from the email on
              your account, or recover the account in the app first.
            </p>
          </Section>
        </Container>
      </main>

      <Footer />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="text-[19px] font-bold tracking-[-0.3px] text-ink">{title}</h2>
      <div className="mt-1 text-[14.5px] leading-[1.7] text-muted">{children}</div>
    </section>
  );
}
