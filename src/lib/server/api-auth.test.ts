import { afterEach, describe, expect, it, vi } from "vitest";
import { isApiAuthorized } from "./api-auth";

afterEach(() => vi.unstubAllEnvs());

describe("API key authorization", () => {
  it.each([undefined, ""])(
    "keeps public access when API_KEY is %s",
    async (key) => {
      vi.stubEnv("API_KEY", key);
      expect(await isApiAuthorized(null)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "Basic test-key",
    "Bearer",
    "Bearer wrong-key",
    "Bearer test-key extra",
    "Bearer TEST-KEY",
  ])("rejects invalid credentials: %s", async (header) => {
    vi.stubEnv("API_KEY", "test-key");
    expect(await isApiAuthorized(header)).toBe(false);
  });

  it.each(["Bearer test-key", "bearer test-key", "BEARER test-key"])(
    "accepts a valid key with scheme %s",
    async (header) => {
      vi.stubEnv("API_KEY", "test-key");
      expect(await isApiAuthorized(header)).toBe(true);
    },
  );

  it("uses the current environment so key rotation invalidates the old key", async () => {
    vi.stubEnv("API_KEY", "old-key");
    expect(await isApiAuthorized("Bearer old-key")).toBe(true);
    vi.stubEnv("API_KEY", "new-key");
    expect(await isApiAuthorized("Bearer old-key")).toBe(false);
    expect(await isApiAuthorized("Bearer new-key")).toBe(true);
  });
});
