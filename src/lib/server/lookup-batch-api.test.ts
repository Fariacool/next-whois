import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "@/pages/api/lookup/batch";
import { lookupWhoisBatch } from "@/lib/whois/lookup";

vi.mock("@/lib/whois/lookup", () => ({ lookupWhoisBatch: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("API_KEY", "test-key");
  vi.stubEnv("WHOIS_BATCH_LIMIT", "2");
  vi.mocked(lookupWhoisBatch).mockResolvedValue({
    status: true,
    time: 0,
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0 },
  });
});
afterEach(() => vi.unstubAllEnvs());

async function call(
  body = '{"queries":["example.com"]}',
  options: {
    method?: string;
    key?: string;
    type?: string;
    length?: string;
  } = {},
) {
  const req = Readable.from([Buffer.from(body)]) as NextApiRequest;
  req.method = options.method ?? "POST";
  req.headers = {
    authorization:
      options.key === "" ? undefined : `Bearer ${options.key ?? "test-key"}`,
    "content-type": options.type ?? "application/json",
    "content-length": options.length,
  };
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
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

describe("batch HTTP contract", () => {
  it.each(["", "wrong-key"])(
    "authenticates %j before parsing malformed JSON",
    async (key) => {
      const response = await call("{invalid", { key });
      expect(response.statusCode).toBe(401);
      expect(response.headers["Cache-Control"]).toContain("no-store");
      expect(response.headers["WWW-Authenticate"]).toContain("Bearer");
      expect(lookupWhoisBatch).not.toHaveBeenCalled();
    },
  );
  it("accepts query strings for item-level validation and disables shared HTTP caching", async () => {
    const response = await call('{"queries":["example.com","bad domain"]}');
    expect(response.statusCode).toBe(200);
    expect(lookupWhoisBatch).toHaveBeenCalledWith([
      "example.com",
      "bad domain",
    ]);
    expect(response.headers["CDN-Cache-Control"]).toBe("no-store");
    expect(response.headers.Vary).toBe("Authorization");
  });
  it.each([
    "{invalid",
    "{}",
    "[]",
    '{"queries":[]}',
    '{"queries":[1]}',
    '{"queries":["a.com"],"extra":true}',
    '{"queries":["a.com","a.com","a.com"]}',
  ])("rejects malformed or excessive batches: %s", async (body) => {
    expect((await call(body)).statusCode).toBe(400);
    expect(lookupWhoisBatch).not.toHaveBeenCalled();
  });
  it("checks methods, content types and actual body bytes", async () => {
    const method = await call("", { method: "GET" });
    expect(method.statusCode).toBe(405);
    expect(method.headers.Allow).toBe("POST");
    expect((await call("{}", { type: "text/plain" })).statusCode).toBe(415);
    expect((await call("{}", { length: "65537" })).statusCode).toBe(413);
    expect((await call(" ".repeat(65537))).statusCode).toBe(413);
  });
  it("allows public access when API_KEY is unset", async () => {
    vi.stubEnv("API_KEY", "");
    expect((await call(undefined, { key: "" })).statusCode).toBe(200);
  });
});
