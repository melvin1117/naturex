import { describe, expect, it } from "vitest";

import { createApi } from "@/lib/api/client";

describe("api client", () => {
  it("creates a client with the default base URL", () => {
    const client = createApi();
    expect(client).toBeDefined();
    expect(typeof client.GET).toBe("function");
    expect(typeof client.POST).toBe("function");
  });

  it("accepts a custom base URL", () => {
    const client = createApi("http://example.test");
    expect(client).toBeDefined();
  });
});
