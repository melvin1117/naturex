import type { Metadata } from "next";
import { Geist_Mono, Hanken_Grotesk, Instrument_Serif } from "next/font/google";

import { AlertToaster } from "@/components/proto/alert-toaster";
import { CopilotSheet } from "@/components/proto/copilot-sheet";
import { DemoBar } from "@/components/proto/demo-bar";
import { SkipLink } from "@/components/skip-link";
import { TourProvider } from "@/components/proto/tour";
import { TraceSheet } from "@/components/proto/trace-sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorldProvider } from "@/components/world-provider";
import { PrototypeProvider } from "@/lib/prototype/store";

import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
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
        className={`${hanken.variable} ${instrument.variable} ${geistMono.variable} flex min-h-dvh flex-col font-sans antialiased`}
      >
        <WorldProvider>
          <PrototypeProvider>
            <TooltipProvider delayDuration={200}>
              <TourProvider>
                <SkipLink />
                {/* The demo bar slot (T65): the sandbox notice on every page, plus the
                    scripted demo's controls for anonymous visitors (T61). */}
                <DemoBar />
                <div className="flex flex-1 flex-col">{children}</div>
                <TraceSheet />
                <CopilotSheet />
                <AlertToaster />
                <Toaster position="top-right" offset={{ top: 64, right: 16 }} />
              </TourProvider>
            </TooltipProvider>
          </PrototypeProvider>
        </WorldProvider>
      </body>
    </html>
  );
}
