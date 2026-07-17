import Image from "next/image";
import { footer } from "@/lib/content";

export function Footer() {
  return (
    <footer className="border-t border-divider bg-canvas-alt">
      <div className="mx-auto flex max-w-[1140px] flex-wrap items-center gap-6 px-8 py-9">
        <div className="flex items-center gap-[3px]">
          <Image
            src="/wcp-logo.png"
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 object-contain"
          />
          <span className="text-[15px] font-bold">WCP Markets</span>
        </div>
        <span className="text-[12px] text-faint">{footer.copyright}</span>
        <div className="flex-1" />
        <div className="flex gap-[22px] text-[12.5px]">
          {footer.links.map((link) => (
            <a key={link.label} href={link.href} className="text-muted">
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
