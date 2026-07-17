import { announcement } from "@/lib/content";

/** Full-width gradient strip with dark text (F-5: gated by `showAnnouncement`). */
export function AnnouncementBar() {
  return (
    <div className="wcp-gradient px-5 py-[9px] text-center text-[13px] font-semibold text-canvas">
      {announcement}
    </div>
  );
}
