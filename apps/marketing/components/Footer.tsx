import Image from "next/image";
import { footer } from "@/lib/content";

export function Footer() {
  return (
    <footer className="border-t border-divider bg-canvas-alt">
      <div className="mx-auto flex max-w-[1140px] flex-col items-center gap-4 px-8 py-9 text-center sm:flex-row sm:gap-6 sm:text-left">
        <div className="flex items-center gap-2">
          <Image
            src="/wcp-logomark.png"
            alt=""
            width={1306}
            height={1439}
            className="h-6 w-auto shrink-0 object-contain"
          />
          <span className="text-[15px] font-bold">WCP Markets</span>
        </div>
        <span className="text-[12px] text-faint">{footer.copyright}</span>
        {/* Spacer only in the desktop row; hidden on mobile so the column
            doesn't stretch. */}
        <div className="hidden flex-1 sm:block" />
        <div className="flex items-center gap-3">
          {footer.socials.map((s) => {
            const external = s.href.startsWith("http");
            return (
              <a
                key={s.kind}
                href={s.href}
                aria-label={s.label}
                title={s.label}
                {...(external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-line-hover hover:text-ink"
              >
                {s.kind === "x" ? <XIcon /> : <MailIcon />}
              </a>
            );
          })}
        </div>
      </div>
    </footer>
  );
}

function XIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="h-[17px] w-[17px]"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[18px] w-[18px]"
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7.5 8.5 5.5 8.5-5.5" />
    </svg>
  );
}
