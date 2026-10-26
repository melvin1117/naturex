import type { MetadataRoute } from "next";

/** Opening any sandbox page creates a sandbox, so crawlers stay on the welcome and the story. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/sandbox", "/api/"] },
  };
}
