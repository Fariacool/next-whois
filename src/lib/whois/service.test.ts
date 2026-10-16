import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoisLookupService } from "./service";
import { getJsonRedisValue, setJsonRedisValue } from "@/lib/server/redis";

vi.mock("@/lib/server/redis", () => ({
  getJsonRedisValue: vi.fn(),
  setJsonRedisValue: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getJsonRedisValue).mockResolvedValue(null);
  vi.stubEnv("REDIS_CACHE_TTL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("shared lookup service", () => {
  it("deduplicates single/batch lookups and retains input order, duplicates and individual errors", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    const provider = vi.fn(async () => {
      await gate;
      return { status: true, time: 1 };
    });
    const service = new WhoisLookupService(provider);
    const single = service.lookup("Example.COM");
    const batch = service.batch([
      "www.example.com",
      "bad domain",
      "example.com",
    ]);
    await Promise.resolve();
    finish();
    const [a, b] = await Promise.all([single, batch]);
    expect(provider).toHaveBeenCalledOnce();
    expect(a.cached).toBe(false);
    expect(b.results.map((item) => item.input)).toEqual([
      "www.example.com",
      "bad domain",
      "example.com",
    ]);
    expect(b.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(b.results[1]).toMatchObject({
      status: false,
      errorCode: "INVALID_QUERY",
    });
    expect(await service.lookup("https://example.com/path")).toMatchObject({
      cached: true,
      time: 0,
    });
  });

  it("expires successful records and never caches failed or thrown lookups", async () => {
    let now = 0;
    const provider = vi.fn().mockResolvedValue({ status: true, time: 1 });
    const service = new WhoisLookupService(provider, () => now, 100);
    await service.lookup("example.com");
    now = 101;
    await service.lookup("example.com");
    expect(provider).toHaveBeenCalledTimes(2);
    provider.mockResolvedValue({ status: false, time: 1, error: "Not found" });
    await service.lookup("missing.com");
    await service.lookup("missing.com");
    expect(provider).toHaveBeenCalledTimes(4);
    provider.mockRejectedValue(new Error("private internal information"));
    const batch = await service.batch(["one.com", "two.com"]);
    expect(batch.summary.failed).toBe(2);
    expect(JSON.stringify(batch)).not.toContain("private internal");
  });

  it("uses unexpired Redis records and tolerates cache outages", async () => {
    const provider = vi.fn().mockResolvedValue({ status: true, time: 1 });
    const service = new WhoisLookupService(provider, () => 100);
    vi.mocked(getJsonRedisValue).mockResolvedValue({
      result: { status: true, time: 1 },
      expiresAt: 200,
    });
    expect(await service.lookup("example.com")).toMatchObject({
      cached: true,
      time: 0,
    });
    expect(provider).not.toHaveBeenCalled();
    vi.mocked(getJsonRedisValue).mockRejectedValue(new Error("cache down"));
    vi.mocked(setJsonRedisValue).mockRejectedValue(new Error("cache down"));
    expect(await service.lookup("example.org")).toMatchObject({
      status: true,
      cached: false,
    });
    expect(await service.lookup("example.org")).toMatchObject({
      status: true,
      cached: true,
    });
  });

  it("bounds pending unique lookups while still allowing duplicates to join", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    const provider = vi.fn(async () => {
      await gate;
      return { status: true, time: 0 };
    });
    const service = new WhoisLookupService(provider);
    const jobs = Array.from({ length: 200 }, (_, i) =>
      service.lookup(`q${i}.com`),
    );
    const duplicate = service.lookup("Q0.COM");
    expect(await service.lookup("overflow.com")).toMatchObject({
      status: false,
      errorCode: "BUSY",
    });
    finish();
    await Promise.all([...jobs, duplicate]);
    expect(provider).toHaveBeenCalledTimes(200);
    expect(await service.lookup("overflow.com")).toMatchObject({
      status: true,
    });
  });
});
