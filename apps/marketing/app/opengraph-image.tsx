import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Branded link-preview card (shown when the site is shared on X, LinkedIn,
// WhatsApp, iMessage, Slack, …). Next wires the og:image meta automatically.
export const alt = "WCP Markets — Buy and sell anything. Money held safe.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  // Read from disk relative to the app's working dir (apps/marketing, both in
  // dev and on Vercel where Root Directory = apps/marketing). next.config's
  // outputFileTracingIncludes ensures the _og fonts ship in the bundle.
  const [bold, medium, logo] = await Promise.all([
    readFile(join(process.cwd(), "app/_og/SpaceGrotesk-Bold.woff")),
    readFile(join(process.cwd(), "app/_og/SpaceGrotesk-Medium.woff")),
    readFile(join(process.cwd(), "public/wcp-logomark.png")),
  ]);

  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0D0F14",
          padding: "72px 80px",
          position: "relative",
          fontFamily: "Space Grotesk",
        }}
      >
        {/* soft brand glow */}
        <div
          style={{
            position: "absolute",
            top: -140,
            left: 260,
            width: 680,
            height: 460,
            background:
              "radial-gradient(circle, rgba(124,92,255,0.35), transparent 70%)",
          }}
        />

        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={58} height={64} alt="" />
          <div style={{ fontSize: 34, fontWeight: 700, color: "#EAEDF2" }}>
            WCP Markets
          </div>
        </div>

        {/* headline pinned to the bottom */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div
            style={{
              fontSize: 78,
              fontWeight: 700,
              color: "#EAEDF2",
              lineHeight: 1.05,
              letterSpacing: -2,
            }}
          >
            Buy and sell anything.
          </div>
          <div
            style={{
              fontSize: 78,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              backgroundImage: "linear-gradient(120deg,#7C5CFF,#22D3EE)",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              color: "transparent",
            }}
          >
            Money held safe.
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 500,
              color: "#8A93A6",
              marginTop: 28,
            }}
          >
            Escrow-backed marketplace for goods, property, vehicles &amp;
            services.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
