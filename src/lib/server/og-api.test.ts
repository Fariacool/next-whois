import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "@/pages/api/og";

beforeEach(() => vi.stubEnv("API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OG API authentication", () => {
  it.each([undefined, "Bearer wrong-key"])(
    "rejects %s without making an internal lookup",
    async (header) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const response = await handler(
        new NextRequest("https://whois.example/api/og?query=example.com", {
          headers: header ? { Authorization: header } : {},
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        status: false,
        time: -1,
        error: "Error 401",
      });
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("forwards the caller's Bearer key and propagates an upstream authentication failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler(
      new NextRequest("https://whois.example/api/og?query=example.com", {
        headers: { Authorization: "Bearer test-key" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://whois.example/api/lookup?query=example.com",
      {
        headers: { Authorization: "Bearer test-key" },
        cache: "no-store",
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Netlify-CDN-Cache-Control")).toBe("no-store");
  });
});
