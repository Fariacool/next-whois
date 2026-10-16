import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyResponse,
  main,
  snapshotRows,
  validTimestamp,
} from "../../../scripts/whois-regression.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function inputFile(domains: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "next-whois-regression-"));
  const input = join(dir, "input.json"),
    output = join(dir, "report.json");
  await writeFile(
    input,
    JSON.stringify({
      issueGroups: [
        {
          suffixes: [
            {
              suffix: "lv",
              domains: domains.map((domain) => ({
                domain,
                lookupProvider: "digga-whois",
                lookupStatus: "partial",
              })),
            },
          ],
        },
      ],
    }),
  );
  return { dir, input, output };
}

describe("optional regression reports", () => {
  it("deduplicates handoff domains without erasing provider attribution", () => {
    const suffix = {
      suffix: "lv",
      domains: [
        {
          domain: "example.lv",
          lookupProvider: "digga-whois",
          lookupStatus: "partial",
        },
      ],
    };
    const rows = snapshotRows({
      issueGroups: [{ suffixes: [suffix] }, { suffixes: [suffix] }],
    });
    expect(rows).toEqual([{ ...suffix.domains[0], suffix: "lv" }]);
  });

  it("validates calendar dates as well as the timestamp shape", () => {
    expect(validTimestamp("2020-02-29T00:00:00Z")).toBe(true);
    expect(validTimestamp("2020-02-30T00:00:00Z")).toBe(false);
    expect(validTimestamp("2020-12-24T00:00:00Z <<<")).toBe(false);
  });

  it("distinguishes polluted errors, real partials and found dates", () => {
    const result = {
      domain: "example.com",
      registrar: "Example Registrar",
      creationDate: "Unknown",
      updatedDate: "Managing Registrar 20201224",
      expirationDate: "Unknown",
    };
    const classify = (overrides: object) =>
      classifyResponse(
        { status: true, result: { ...result, ...overrides } },
        "example.com",
      );
    expect(classify({})).toEqual({
      status: "error",
      invalidDates: ["updatedDate"],
    });
    expect(classify({ updatedDate: "Unknown" }).status).toBe("partial");
    expect(
      classify({ updatedDate: "Unknown", registrar: "Unknown" }).status,
    ).toBe("no_data");
    expect(
      classify({ creationDate: "2020-12-24T00:00:00Z", updatedDate: "Unknown" })
        .status,
    ).toBe("found");
    expect(classify({ domain: "com" }).status).toBe("error");
    expect(
      classifyResponse(
        { status: false, error: "Unsupported WHOIS/RDAP namespace" },
        "example.nhs.uk",
      ).status,
    ).toBe("unsupported");
  });

  it("compares endpoints with Bearer keys and counts only paired observations", async () => {
    const files = await inputFile(["example.lv"]);
    const result = {
      domain: "example.lv",
      registrar: "Example Registrar",
      creationDate: "Unknown",
      expirationDate: "Unknown",
      updatedDate: "Unknown",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: true,
            result: { ...result, updatedDate: "Managing Registrar 20201224" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: true, result })),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("API_KEY", "new-test-key");
    vi.stubEnv("BASELINE_API_KEY", "old-test-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await main([
        "--input",
        files.input,
        "--output",
        files.output,
        "--endpoint",
        "http://127.0.0.1:3001",
        "--baseline-endpoint",
        "http://127.0.0.1:3002",
        "--delay-ms",
        "0",
      ]);
      const text = await readFile(files.output, "utf8"),
        report = JSON.parse(text);
      expect(report.bySuffix.lv.transitions).toEqual({ "error->partial": 1 });
      expect(report.bySuffix.lv.baselineErrorTo).toEqual({ partial: 1 });
      expect(report.bySuffix.lv.historicalByProvider).toEqual({
        "digga-whois:partial": 1,
      });
      expect(
        fetchMock.mock.calls.map(
          ([, options]) => options.headers.Authorization,
        ),
      ).toEqual(["Bearer old-test-key", "Bearer new-test-key"]);
      expect(text).not.toContain("test-key");
    } finally {
      await rm(files.dir, { recursive: true, force: true });
    }
  });

  it("stops at the first authentication failure instead of scanning the list", async () => {
    const files = await inputFile(["one.lv", "two.lv"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        main([
          "--input",
          files.input,
          "--output",
          files.output,
          "--endpoint",
          "http://127.0.0.1:3001",
          "--all",
          "--delay-ms",
          "0",
        ]),
      ).rejects.toThrow("Authentication failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(files.output, "utf8")).results).toEqual(
        [],
      );
    } finally {
      await rm(files.dir, { recursive: true, force: true });
    }
  });
});
