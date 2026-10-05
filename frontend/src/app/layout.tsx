import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SandboxBanner } from "@/components/sandbox-banner";
import { SiteHeader } from "@/components/site-header";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "NatureX",
    template: "%s · NatureX",
  },
  description:
    "AI rating agency and sandbox exchange for living nature. Play money only, not a real security.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} flex min-h-dvh flex-col antialiased`}
      >
        <SandboxBanner />
        <SiteHeader />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
