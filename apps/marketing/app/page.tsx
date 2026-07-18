import { WaitlistProvider } from "@/components/WaitlistProvider";
import { WaitlistDialog } from "@/components/WaitlistDialog";
import { SectionViewTracker } from "@/components/SectionViewTracker";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { LanesSection } from "@/components/LanesSection";
import { EscrowSection } from "@/components/EscrowSection";
import { AiSearchSection } from "@/components/AiSearchSection";
import { TrustSection } from "@/components/TrustSection";
import { FaqSection } from "@/components/FaqSection";
import { WaitlistSection } from "@/components/WaitlistSection";
import { Footer } from "@/components/Footer";
import { flags } from "@/lib/flags";

const TRACKED_SECTIONS = ["lanes", "escrow", "ai", "faq", "waitlist"];

export default function Page() {
  return (
    <WaitlistProvider>
      {flags.showAnnouncement && <AnnouncementBar />}
      <Nav />
      <main>
        <Hero />
        <LanesSection />
        <EscrowSection />
        <AiSearchSection />
        <TrustSection />
        <FaqSection />
        <WaitlistSection />
      </main>
      <Footer />
      <WaitlistDialog />
      <SectionViewTracker ids={TRACKED_SECTIONS} />
    </WaitlistProvider>
  );
}
