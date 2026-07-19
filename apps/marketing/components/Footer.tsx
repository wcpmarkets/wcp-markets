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
        <a
          href="/privacy"
          className="text-[12px] text-muted transition-colors hover:text-ink"
        >
          Privacy
        </a>
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
                {s.kind === "x" ? (
                  <XIcon />
                ) : s.kind === "linkedin" ? (
                  <LinkedInIcon />
                ) : (
                  <MailIcon />
                )}
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

function LinkedInIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="h-[17px] w-[17px]"
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
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
