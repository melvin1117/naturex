import type { Metadata } from "next";
import { Geist_Mono, Gloock, Hanken_Grotesk } from "next/font/google";

import { LeftoverDemo } from "@/components/shell/leftover-demo";
import { SkipLink } from "@/components/shell/skip-link";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorldProvider } from "@/components/world-provider";
import { TOASTER_PROPS } from "@/lib/feedback";

import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

// The display face (DESIGN.md): names, page titles and the wordmark's "Wild". One weight, no
// italic.
const gloock = Gloock({
  variable: "--font-gloock",
  subsets: ["latin", "latin-ext"],
  weight: "400",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** SITE_URL, when it's a valid absolute URL; a bad value must not stop the app from starting. */
function siteUrl(): URL | undefined {
  try {
    return process.env.SITE_URL ? new URL(process.env.SITE_URL) : undefined;
  } catch {
    return undefined;
  }
}

const DESCRIPTION =
  "Worth more wild. The AI rating agency for living nature: satellites and local news, read by Nemotron agents. Sandbox · play money only.";

export const metadata: Metadata = {
  // Absolute links for link previews; without SITE_URL, Next falls back to the dev host.
  metadataBase: siteUrl(),
  title: {
    default: "WildWorth · nature ratings",
    template: "%s · WildWorth",
  },
  description: DESCRIPTION,
  applicationName: "WildWorth",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    siteName: "WildWorth",
    title: "WildWorth · nature ratings",
    description: DESCRIPTION,
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "WildWorth. Worth more wild.",
      },
    ],
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${hanken.variable} ${gloock.variable} ${geistMono.variable} flex min-h-dvh flex-col font-sans antialiased`}
      >
        <WorldProvider>
          <TooltipProvider delayDuration={200}>
            <SkipLink />
            <LeftoverDemo />
            <div className="flex flex-1 flex-col">{children}</div>
            {/* Bottom, clear of the header, person menu and trade panel (lib/feedback). */}
            <Toaster {...TOASTER_PROPS} />
          </TooltipProvider>
        </WorldProvider>
      </body>
    </html>
  );
}
