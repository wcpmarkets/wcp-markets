import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Container } from "@wcp/ui";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy — WCP Markets",
  description:
    "How WCP Markets collects, uses, and protects the information you share when joining the waitlist.",
};

export default function PrivacyPage() {
  return (
    <>
      <header className="border-b border-divider">
        <Container className="flex items-center py-[22px]">
          <Link href="/" className="flex items-center gap-2" aria-label="WCP Markets — home">
            <Image
              src="/wcp-logomark.png"
              alt=""
              width={1306}
              height={1439}
              className="h-7 w-auto shrink-0 object-contain"
            />
            <span className="text-[18px] font-bold tracking-[-0.3px] text-ink">
              WCP Markets
            </span>
          </Link>
        </Container>
      </header>

      <main>
        <Container className="max-w-[760px] py-16">
          <h1 className="text-[34px] font-bold tracking-[-1px]">Privacy Policy</h1>
          <p className="mt-2 text-[13px] text-faint">Last updated: 19 July 2026</p>

          <p className="mt-6 text-[15px] leading-[1.7] text-muted">
            WCP Markets (&quot;WCP&quot;, &quot;we&quot;, &quot;us&quot;) is
            building an escrow-backed marketplace for Nigeria. This site is our
            pre-launch waitlist. This policy explains what we collect when you use
            it and join the waitlist, why, and the choices you have. The app and
            its transactions are not live yet; this policy covers the waitlist
            site only and will be expanded before launch.
          </p>

          <Section title="1. Information we collect">
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <b className="text-ink-secondary">What you give us:</b> your email
                address, and (optionally) whether you intend to buy, sell, or
                both, when you join the waitlist.
              </li>
              <li>
                <b className="text-ink-secondary">Collected automatically:</b>{" "}
                basic usage and device data (pages viewed, interactions, approximate
                location by IP, browser type) through our analytics provider, to
                understand how the site is used.
              </li>
            </ul>
          </Section>

          <Section title="2. How we use it">
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>To email you about the launch and when your city goes live.</li>
              <li>
                To gauge interest (e.g. how many people want to buy vs. sell) and
                prioritise our rollout.
              </li>
              <li>To measure and improve the website.</li>
            </ul>
            <p className="mt-3">
              We do <b className="text-ink-secondary">not</b> sell your personal
              data, and we won&apos;t send you unrelated marketing.
            </p>
          </Section>

          <Section title="3. Who we share it with">
            <p className="mt-3">
              We use a small number of trusted service providers to run the site:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <b className="text-ink-secondary">Supabase</b> — stores the
                waitlist (your email and intent) in a secured database.
              </li>
              <li>
                <b className="text-ink-secondary">Vercel</b> — hosts and serves the
                website.
              </li>
              <li>
                <b className="text-ink-secondary">PostHog</b> — product analytics
                (usage data described above).
              </li>
            </ul>
            <p className="mt-3">
              These providers process data on our behalf. We may also disclose
              information if required by law.
            </p>
          </Section>

          <Section title="4. Cookies">
            <p className="mt-3">
              Our analytics provider sets cookies to recognise returning visitors
              and measure usage. You can block or delete cookies in your browser
              settings; the site will still work.
            </p>
          </Section>

          <Section title="5. How long we keep it">
            <p className="mt-3">
              We keep your waitlist details until launch and for a reasonable
              period afterwards, or until you ask us to delete them — whichever is
              sooner.
            </p>
          </Section>

          <Section title="6. Your rights">
            <p className="mt-3">
              Under Nigeria&apos;s Data Protection regulations (and other laws that
              may apply to you), you can request access to, correction of, or
              deletion of your personal data, and you can withdraw consent at any
              time. To exercise any of these, email us at the address below.
            </p>
          </Section>

          <Section title="7. Security">
            <p className="mt-3">
              We take reasonable measures to protect your information and limit
              access to it. No method of transmission or storage is completely
              secure, but we work to keep your data safe.
            </p>
          </Section>

          <Section title="8. Children">
            <p className="mt-3">
              This site is not directed at children under 18, and we do not
              knowingly collect their data.
            </p>
          </Section>

          <Section title="9. Changes">
            <p className="mt-3">
              We may update this policy as the product develops. Material changes
              will be reflected here with a new &quot;last updated&quot; date.
            </p>
          </Section>

          <Section title="10. Contact">
            <p className="mt-3">
              Questions or requests about your data? Email{" "}
              <a
                href="https://mail.google.com/mail/?view=cm&fs=1&to=wcpmarketsng@gmail.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                wcpmarketsng@gmail.com
              </a>
              .
            </p>
          </Section>
        </Container>
      </main>

      <Footer />
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <h2 className="text-[19px] font-bold tracking-[-0.3px] text-ink">{title}</h2>
      <div className="mt-1 text-[14.5px] leading-[1.7] text-muted">{children}</div>
    </section>
  );
}
