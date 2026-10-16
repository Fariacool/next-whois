import { LookupError } from "./errors";

type Job = {
  host: string;
  signal: AbortSignal;
  start: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

// A permit lasts until the actual HTTP body / TCP connection has finished.
export class UpstreamScheduler {
  private active = 0;
  private perHost = new Map<string, number>();
  private queue: Job[] = [];
  private cooldowns = new Map<string, number>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly perServerConcurrent: number,
    private readonly maxQueued = 200,
  ) {}

  cooldown(host: string, seconds: number) {
    host = host.toLowerCase();
    this.cooldowns.set(
      host,
      Math.max(this.cooldowns.get(host) ?? 0, Date.now() + seconds * 1_000),
    );
    this.drain();
  }

  private rateLimit(host: string) {
    const until = this.cooldowns.get(host);
    if (!until) return null;
    if (until <= Date.now()) {
      this.cooldowns.delete(host);
      return null;
    }
    return new LookupError(
      "UPSTREAM_RATE_LIMITED",
      `The upstream server ${host} is rate limited. Retry later.`,
      Math.max(1, Math.ceil((until - Date.now()) / 1_000)),
    );
  }

  run<T>(
    host: string,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    host = host.toLowerCase();
    if (signal.aborted)
      return Promise.reject(
        new LookupError("LOOKUP_TIMEOUT", "The lookup timed out."),
      );
    const limited = this.rateLimit(host);
    if (limited) return Promise.reject(limited);
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new LookupError("BUSY", "The lookup queue is full. Retry later.", 1),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        host,
        signal,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          reject(
            new LookupError(
              "LOOKUP_TIMEOUT",
              "The lookup timed out while waiting for an upstream slot.",
            ),
          );
        },
        start: () => {
          this.active++;
          this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1);
          const release = () => {
            this.active--;
            const count = (this.perHost.get(host) ?? 1) - 1;
            if (count) this.perHost.set(host, count);
            else this.perHost.delete(host);
            this.drain();
          };
          void Promise.resolve()
            .then(task)
            .then(
              (value) => {
                release();
                resolve(value);
              },
              (error) => {
                release();
                reject(error);
              },
            );
        },
      };
      signal.addEventListener("abort", job.onAbort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  private drain() {
    // Skip saturated hosts so a busy registry cannot block other registries.
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index];
      const limited = this.rateLimit(job.host);
      if (limited || job.signal.aborted) {
        this.queue.splice(index, 1);
        job.signal.removeEventListener("abort", job.onAbort);
        job.reject(
          limited ?? new LookupError("LOOKUP_TIMEOUT", "The lookup timed out."),
        );
      } else if (
        this.active < this.maxConcurrent &&
        (this.perHost.get(job.host) ?? 0) < this.perServerConcurrent
      ) {
        this.queue.splice(index, 1);
        job.signal.removeEventListener("abort", job.onAbort);
        job.start();
      } else {
        index++;
      }
    }
  }
}
