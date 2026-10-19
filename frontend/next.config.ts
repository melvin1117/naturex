import type { NextConfig } from "next";

// The browser calls /api/* on the frontend's own origin and Next.js proxies it to the
// backend, so the `nx_session` cookie (SameSite=Lax) is first-party (T54, T20).
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // shadcn components import the `radix-ui` barrel; without this, a client component that
  // uses <Button> ships every Radix primitive (~75 kB gzipped) on every page.
  experimental: { optimizePackageImports: ["radix-ui"] },
  async redirects() {
    // ADR-0005: listing moved into the Steward app.
    return [
      { source: "/list", destination: "/steward/list", permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/:path*` }];
  },
};

export default nextConfig;
