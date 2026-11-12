import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Container } from "@wcp/ui";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy — WCP Markets",
  description:
    "What WCP Markets collects in the app and on the website, why, who it's shared with, how long it's kept, and your rights under the NDPA.",
};

const CONTACT = "cx@wcpmarkets.com";
const DPO = "hassan@wcpmarkets.com";

/** [what, details, source] */
const COLLECTED: [string, string, string][] = [
  ["Account", "Your phone number, and an email address if you add one for receipts", "You, when you sign up"],
  ["Profile", "Display name, store name, bio, profile photo, state and city, \"last seen\" (you can turn this off)", "You"],
  ["Listings", "Titles, descriptions, prices, photos, category details, and for shortlets the location and availability", "You, when you list something"],
  ["Messages", "Chats with other users, offers and quotes", "You and the other person"],
  ["Deals and payments", "What you bought or sold, amounts, deal status, delivery or stay dates, reviews and disputes", "The app, and Paystack for payment status"],
  ["Delivery addresses", "Addresses you save for deliveries", "You"],
  ["Payout account", "Bank name, account name and the last 4 digits of the account number. Paystack holds the full number", "You, checked with your bank through Paystack"],
  ["Identity check (sellers)", "Whether your BVN or NIN matched your selfie, and a one-way keyed code of the number, used to confirm it's you if you ever need to recover your account. We never store your BVN, NIN or selfie", "Smile ID, from what you enter and capture"],
  ["Searches and saved items", "What you search for (typed, spoken or by photo), saved listings, price watches", "You"],
  ["Approximate location", "Your state, from your phone's coarse location, to show listings near you. Never your precise location", "Your phone, if you allow it"],
  ["Device and notifications", "A push-notification token and basic device type", "Your phone"],
  ["Website use", "Pages viewed, approximate location by IP, browser type, via cookies; your email if you join the waitlist", "Your browser"],
];

/** [purpose, data used, lawful basis] */
const USES: [string, string, string][] = [
  ["Create your account and sign you in by SMS code", "Phone number", "Contract"],
  ["Show your listings and profile to buyers", "Profile, listings", "Contract"],
  ["Hold payments in escrow, release them, refund them and pay sellers", "Deals, payments, payout account", "Contract"],
  ["Check a seller's identity before their first payout", "Identity check", "Legitimate interest in keeping buyers safe from fraud"],
  ["Let buyers and sellers talk and agree a deal", "Messages, delivery addresses", "Contract"],
  ["Send deal, message and price-drop notifications, SMS alerts and receipts", "Device token, phone number, email", "Contract; price-drop alerts only for watches you set up"],
  ["Understand searches (AI search and photo search) and show listings near you", "Searches, photos you search with, approximate location", "Contract; location only with your permission"],
  ["Prevent fraud, resolve disputes and enforce our terms", "Deals, messages, reports", "Legitimate interest"],
  ["Keep financial records", "Deals, payments, payouts", "Legal obligation"],
  ["Improve the website and tell waitlist members about launch", "Website use, waitlist email", "Consent (you can withdraw it at any time)"],
];

/** [provider, what they do, what they receive] */
const PROVIDERS: [string, string, string][] = [
  ["Paystack", "Card and bank payments, refunds, seller payouts", "Payment details, amounts, payout bank account, your email for receipts"],
  ["Smile ID", "Seller identity checks", "Your BVN or NIN and a live selfie, sent from the app; they compare it with the NIBSS or NIMC record"],
  ["Supabase", "Database, sign-in, file storage", "All account and marketplace data"],
  ["Amazon Web Services", "Runs our servers", "Data passing through the app's API"],
  ["Termii", "SMS sign-in codes and alerts", "Your phone number and the message"],
  ["Resend", "Receipt and notification emails", "Your email address and the message"],
  ["Google (Firebase Cloud Messaging, Maps)", "Push notifications; maps on shortlet listings", "Device push token; map views"],
  ["Anthropic", "Interprets AI searches and photo searches", "The search text or photo, without your name or phone number"],
  ["Vercel, PostHog", "Host the website; website analytics", "Website use data"],
];

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
          <p className="mt-2 text-[13px] text-faint">Last updated: 12 November 2026</p>

          <Section title="1. Who we are">
            <p className="mt-3">
              WCP Markets Nigeria Limited (RC 8523753, &quot;WCP Markets&quot;,
              &quot;we&quot;, &quot;us&quot;) runs an escrow-backed marketplace for
              Nigeria: the WCP Markets Android app, the website at wcpmarkets.com and
              our waitlist. We are the data controller for the personal data described
              here.
            </p>
            <p className="mt-3">
              This policy explains what we collect when you use any of them, why, who
              we share it with, how long we keep it and the rights you have under the
              Nigeria Data Protection Act 2023 (NDPA). It applies whether you buy, sell,
              host a shortlet or just browse.
            </p>
            <p className="mt-3">
              We do <b className="text-ink-secondary">not</b> sell your personal data,
              and we do not use it for advertising.
            </p>
          </Section>

          <Section title="2. What we collect">
            <p className="mt-3">
              We collect what you give us, what the app records as you use it, and what
              our partners send back to us.
            </p>
            <Rows rows={COLLECTED} labels={["Includes", "From"]} />
            <p className="mt-4">
              We do not collect your contacts, call logs, SMS, files or precise
              location. Card details go straight to Paystack and never reach us. Voice
              search uses your phone&apos;s own speech recogniser, so we receive only
              the text.
            </p>
          </Section>

          <Section title="3. How we use it">
            <p className="mt-3">
              We use your data only to run the marketplace safely, and the NDPA
              requires a lawful basis for each use.
            </p>
            <Rows rows={USES} labels={["Data used", "Lawful basis"]} />
            <p className="mt-4">
              Your address is shared with the other person only inside a deal you have
              both agreed. We do not make decisions about you using only automated
              processing that have legal or similarly significant effects. The identity
              check is automated, but you can retry a failed match or contact us to
              have it looked at.
            </p>
          </Section>

          <Section title="4. Who we share it with">
            <p className="mt-3">
              <b className="text-ink-secondary">Other users</b> see your display name,
              store name, photo, area, listings, reviews and, unless you turn it off,
              when you were last seen. The person you are dealing with also sees your
              messages, and your delivery address or stay details once a deal is
              agreed. Your phone number is never shown to other users.
            </p>
            <p className="mt-3">
              <b className="text-ink-secondary">Service providers</b> process data for
              us under contract, only to provide their service:
            </p>
            <Rows rows={PROVIDERS} labels={["What they do", "What they receive"]} />
            <p className="mt-4">
              <b className="text-ink-secondary">When the law requires it</b>, we
              disclose data to courts, regulators or law enforcement in response to a
              valid legal request, and to protect users from fraud or harm.
            </p>
            <p className="mt-3">
              <b className="text-ink-secondary">If WCP Markets is sold or merged</b>,
              your data would pass to the new owner under this policy, and we would
              tell you first.
            </p>
          </Section>

          <Section title="5. Data stored outside Nigeria">
            <p className="mt-3">
              Our servers run in the European Union (Amazon Web Services, Ireland), and
              some providers above are based in the United States or elsewhere.
            </p>
            <p className="mt-3">
              When data leaves Nigeria, we rely on the safeguards the NDPA allows: the
              destination&apos;s adequate data-protection law, or contract terms with
              the provider that protect your data to the NDPA standard. Ask us for
              details of the safeguard that applies to a provider.
            </p>
          </Section>

          <Section title="6. How long we keep it, and deleting your account">
            <p className="mt-3">
              We keep your data while your account is open. You can delete your account
              at any time in the app (
              <b className="text-ink-secondary">
                Account → Privacy &amp; security → Delete my account
              </b>
              ) or at{" "}
              <Link href="/delete-account" className="font-semibold text-ink-secondary underline">
                wcpmarkets.com/delete-account
              </Link>
              , where you confirm with a code sent to your phone.
            </p>
            <p className="mt-3">
              An account can&apos;t be deleted while a deal is still open or a payout
              is pending, because money is still moving. Finish or cancel those first
              and the app lists which ones they are.
            </p>
            <p className="mt-3">
              <b className="text-ink-secondary">Deleted straight away:</b>
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>your name, store name, bio, photo, area and phone number;</li>
              <li>listings that haven&apos;t sold, and their photos;</li>
              <li>saved items, price watches, notifications and saved addresses;</li>
              <li>your payout bank account and receipt email;</li>
              <li>
                your sign-in. Every device is signed out, and the number can later sign
                up as a new, empty account.
              </li>
            </ul>
            <p className="mt-3">
              <b className="text-ink-secondary">Kept, without your name:</b>
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                completed deals, payments, payouts, reviews and disputes. These are
                financial records we must keep by law, and the other person still needs
                them;
              </li>
              <li>messages you sent, which stay in the other person&apos;s chat;</li>
              <li>
                the result of your identity check (match or no match, and the keyed
                code), as a record that the check was done. It never includes your BVN
                or NIN.
              </li>
            </ul>
            <p className="mt-3">
              We keep financial and identity-check records for 5 years after the deal
              or check ends, as Nigerian law requires, then delete them. Waitlist
              emails are kept until 12 months after launch, or until you ask us to
              remove them. Website analytics are kept for up to 12 months.
            </p>
          </Section>

          <Section title="7. Your rights">
            <p className="mt-3">Under the NDPA you can ask us to:</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>give you a copy of your personal data, or send it to another service;</li>
              <li>correct data that is wrong. You can edit most of your profile in the app;</li>
              <li>delete your data (section 6);</li>
              <li>
                stop or limit a use of your data, or object to one based on our
                legitimate interests;
              </li>
              <li>
                withdraw consent you gave, such as location access or waitlist emails.
                This doesn&apos;t affect what we did before.
              </li>
            </ul>
            <p className="mt-3">
              Email us at the address below. We reply within 30 days and may ask you to
              prove the account is yours. If you&apos;re unhappy with our answer, you
              can complain to the Nigeria Data Protection Commission (
              <a href="https://ndpc.gov.ng" target="_blank" rel="noopener noreferrer" className="underline">
                ndpc.gov.ng
              </a>
              ).
            </p>
          </Section>

          <Section title="8. Children">
            <p className="mt-3">
              WCP Markets is for people aged 18 and over. We don&apos;t knowingly
              collect children&apos;s data, and we delete an account we learn belongs
              to a child.
            </p>
          </Section>

          <Section title="9. Security">
            <p className="mt-3">
              All data travels encrypted. On your phone, your sign-in is encrypted with
              a key that never leaves the device, and it is left out of backups.
              Identity numbers are stored only as a keyed one-way code, and only staff
              who need data for their role can access it. No system is perfectly
              secure; if a breach puts your data at risk, we will tell the NDPC within
              72 hours of finding out, and tell you without undue delay.
            </p>
          </Section>

          <Section title="10. Cookies">
            <p className="mt-3">
              The website uses analytics cookies to count visits and understand how it
              is used. You can block or delete them in your browser and the site still
              works. The app does not use cookies.
            </p>
          </Section>

          <Section title="11. Changes">
            <p className="mt-3">
              We will update this policy as WCP Markets changes and show the new date
              at the top. For a significant change, we will also tell you in the app
              before it takes effect.
            </p>
          </Section>

          <Section title="12. Contact">
            <p className="mt-3">
              Questions or requests about your data: <Mail to={CONTACT} />
            </p>
            <p className="mt-2">
              Data Protection Officer: <Mail to={DPO} />
            </p>
            <p className="mt-2">
              WCP Markets Nigeria Limited, 32, 322 Road, Gwarinpa, Abuja. RC 8523753.
            </p>
          </Section>
        </Container>
      </main>

      <Footer />
    </>
  );
}

function Mail({ to }: { to: string }) {
  return (
    <a href={`mailto:${to}`} className="font-semibold text-ink-secondary underline">
      {to}
    </a>
  );
}

/** A three-column table that stacks on phones instead of scrolling sideways. */
function Rows({ rows, labels }: { rows: [string, string, string][]; labels: [string, string] }) {
  return (
    <div className="mt-4 divide-y divide-divider border-y border-divider">
      {rows.map(([title, a, b]) => (
        <div key={title} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[160px_1fr_180px]">
          <div className="font-semibold text-ink-secondary">{title}</div>
          <div>
            <span className="text-faint sm:hidden">{labels[0]}: </span>
            {a}
          </div>
          <div>
            <span className="text-faint sm:hidden">{labels[1]}: </span>
            {b}
          </div>
        </div>
      ))}
    </div>
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
