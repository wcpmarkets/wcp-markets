import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "WCP Markets — Buy and sell anything. Money held safe.",
  description:
    "WCP Markets is a marketplace for goods, property, vehicles and services — where every naira sits in escrow until you confirm the deal. Join the waitlist.",
  applicationName: "WCP Markets",
  keywords: [
    "WCP Markets",
    "Nigeria marketplace",
    "escrow",
    "buy and sell",
  ],
  openGraph: {
    title: "WCP Markets — Buy and sell anything. Money held safe.",
    description:
      "A Nigerian marketplace for goods, property, vehicles and services — every naira held safe in escrow until you confirm.",
    siteName: "WCP Markets",
    locale: "en_NG",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0D0F14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body>{children}</body>
    </html>
  );
}
