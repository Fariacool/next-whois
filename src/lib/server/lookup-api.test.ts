import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "@/pages/api/lookup";
import { lookupWhoisWithCache } from "@/lib/whois/lookup";

vi.mock("@/lib/whois/lookup", () => ({ lookupWhoisWithCache: vi.fn() }));

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function call(
  authorization?: string,
  query: Record<string, string> = { query: "example.com" },
) {
  const res = mockResponse();
  await handler(
    { headers: { authorization }, query } as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("API_KEY", "test-key");
  vi.mocked(lookupWhoisWithCache).mockResolvedValue({
    status: true,
    time: 0,
    cached: true,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("lookup API authentication", () => {
  it.each([undefined, "Bearer wrong-key"])(
    "rejects %s before any lookup or cache access",
    async (header) => {
      const res = await call(header);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ status: false, time: -1, error: "Error 401" });
      expect(res.headers["WWW-Authenticate"]).toContain("Bearer");
      expect(res.headers["Cache-Control"]).toContain("no-store");
      expect(res.headers["Netlify-CDN-Cache-Control"]).toBe("no-store");
      expect(lookupWhoisWithCache).not.toHaveBeenCalled();
    },
  );

  it("does not accept a key from query parameters", async () => {
    const res = await call(undefined, {
      query: "example.com",
      API_KEY: "test-key",
    });
    expect(res.statusCode).toBe(401);
    expect(lookupWhoisWithCache).not.toHaveBeenCalled();
  });

  it("authenticates before validating query parameters", async () => {
    expect((await call(undefined, {})).statusCode).toBe(401);
    expect((await call("Bearer test-key", {})).statusCode).toBe(400);
  });

  it("returns cached data only after authentication and disables shared caching", async () => {
    const res = await call("Bearer test-key");
    expect(res.statusCode).toBe(200);
    expect(lookupWhoisWithCache).toHaveBeenCalledWith("example.com");
    expect(res.headers["Cache-Control"]).toBe("private, no-store, max-age=0");
    expect(res.headers.Vary).toBe("Authorization");
    expect(res.headers["CDN-Cache-Control"]).toBe("no-store");
  });

  it("preserves public access and shared caching when API_KEY is unset", async () => {
    vi.stubEnv("API_KEY", undefined);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toContain("s-maxage=3600");
  });
});
