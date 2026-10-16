import { afterEach, describe, expect, it, vi } from "vitest";
import { requestApi } from "./api-client";

afterEach(() => vi.unstubAllGlobals());

describe("browser API requests", () => {
  it("sends Bearer credentials in a header and omits cookies and caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await requestApi("/api/lookup?query=example.com", "test-key", {
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "force-cache",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lookup?query=example.com");
    expect(init.headers.get("Authorization")).toBe("Bearer test-key");
    expect(init.headers.get("Accept")).toBe("application/json");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });

  it("removes the Authorization header when the key is cleared", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await requestApi("/api/og", "", {
      headers: { Authorization: "Bearer old-key" },
    });
    expect(fetchMock.mock.calls[0][1].headers.has("Authorization")).toBe(false);
  });

  it("does not send the key to external or non-API URLs", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() =>
      requestApi("https://example.com/api/lookup", "test-key"),
    ).toThrow();
    expect(() => requestApi("//example.com/api/lookup", "test-key")).toThrow();
    expect(() => requestApi("/example.com", "test-key")).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
