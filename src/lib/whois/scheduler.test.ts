import { describe, expect, it } from "vitest";
import { UpstreamScheduler } from "./scheduler";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("shared outbound scheduling", () => {
  it("enforces total and per-host limits while skipping saturated hosts", async () => {
    const scheduler = new UpstreamScheduler(3, 2);
    const gate = deferred();
    const hosts = ["a", "A", "a", "b", "b", "c"];
    const counts = new Map<string, number>();
    let active = 0;
    let peak = 0;
    let perHostPeak = 0;
    const started: string[] = [];
    const jobs = hosts.map((host) =>
      scheduler.run(host, AbortSignal.timeout(1_000), async () => {
        host = host.toLowerCase();
        started.push(host);
        counts.set(host, (counts.get(host) ?? 0) + 1);
        peak = Math.max(peak, ++active);
        perHostPeak = Math.max(perHostPeak, counts.get(host)!);
        await gate.promise;
        active--;
        counts.set(host, counts.get(host)! - 1);
      }),
    );
    await Promise.resolve();
    expect(started).toEqual(["a", "a", "b"]);
    gate.resolve();
    await Promise.all(jobs);
    expect(peak).toBe(3);
    expect(perHostPeak).toBe(2);
  });

  it("bounds queues, removes cancelled jobs and releases failed permits", async () => {
    const scheduler = new UpstreamScheduler(1, 1, 1);
    const gate = deferred();
    const running = scheduler.run(
      "a",
      AbortSignal.timeout(1_000),
      () => gate.promise,
    );
    const abort = new AbortController();
    let started = false;
    const queued = scheduler.run("a", abort.signal, async () => {
      started = true;
    });
    await expect(
      scheduler.run("b", AbortSignal.timeout(1_000), async () => {}),
    ).rejects.toMatchObject({ code: "BUSY" });
    abort.abort();
    await expect(queued).rejects.toMatchObject({ code: "LOOKUP_TIMEOUT" });
    expect(started).toBe(false);
    gate.resolve();
    await running;
    await expect(
      scheduler.run("b", AbortSignal.timeout(1_000), async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      scheduler.run("b", AbortSignal.timeout(1_000), async () => "released"),
    ).resolves.toBe("released");
  });

  it("shares host cooldowns with queued and later calls", async () => {
    const scheduler = new UpstreamScheduler(1, 1);
    const gate = deferred();
    const running = scheduler.run(
      "a",
      AbortSignal.timeout(1_000),
      () => gate.promise,
    );
    const queued = scheduler.run(
      "a",
      AbortSignal.timeout(1_000),
      async () => {},
    );
    scheduler.cooldown("A", 60);
    await expect(queued).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterSeconds: 60,
    });
    await expect(
      scheduler.run("a", AbortSignal.timeout(1_000), async () => {}),
    ).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    gate.resolve();
    await running;
    await expect(
      scheduler.run("b", AbortSignal.timeout(1_000), async () => "other host"),
    ).resolves.toBe("other host");
  });
});
