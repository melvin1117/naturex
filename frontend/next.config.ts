import type { NextConfig } from "next";

// The browser calls /api/* on the frontend's own origin and Next.js proxies it to the
// backend, so the `ww_session` cookie (SameSite=Lax) is first-party (T54, T20).
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";
const e2eBuild = process.env.NEXT_E2E_BUILD === "1";

const nextConfig: NextConfig = {
  // The E2E build (T74, playwright.config.ts) proxies to its own API port, which is baked in
  // at build time; its own directory keeps it from replacing a developer's `.next`, and its
  // own tsconfig (which already includes that directory's types) stops the build rewriting
  // tsconfig.json.
  distDir: e2eBuild ? ".next-e2e" : ".next",
  typescript: {
    tsconfigPath: e2eBuild ? "tsconfig.e2e.json" : "tsconfig.json",
  },
  // shadcn components import the `radix-ui` barrel; without this, a client component that
  // uses <Button> ships every Radix primitive (~75 kB gzipped) on every page.
  experimental: { optimizePackageImports: ["radix-ui"] },
  async redirects() {
    // WildWorth runs in the visitor's sandbox (no sign-up): the welcome is `/`, the story
    // `/how`, and every app page lives under `/sandbox`. Old addresses still land somewhere.
    const temporary = (source: string, destination: string) => ({
      source,
      destination,
      permanent: false,
    });
    return [
      temporary("/judge", "/how"),
      temporary("/login", "/sandbox"),
      temporary("/register", "/sandbox"),
      temporary("/list", "/sandbox/steward/list"),
      temporary("/ai", "/sandbox"),
      temporary("/sandbox/ai", "/sandbox"),
      temporary("/asset/:path*", "/sandbox/asset/:path*"),
      temporary("/trace/:path*", "/sandbox/trace/:path*"),
      temporary("/portfolio", "/sandbox/portfolio"),
      temporary("/steward", "/sandbox/steward"),
      temporary("/steward/:path*", "/sandbox/steward/:path*"),
      temporary("/admin", "/sandbox/admin"),
      temporary("/admin/:path*", "/sandbox/admin/:path*"),
    ];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/:path*` }];
  },
};

export default nextConfig;
