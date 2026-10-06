import type { NextConfig } from "next";

// The browser calls /api/* on the frontend's own origin and Next.js proxies it to the
// backend, so the `nx_world` sandbox cookie (SameSite=Lax) is first-party (T31, T20).
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/:path*` }];
  },
};

export default nextConfig;
