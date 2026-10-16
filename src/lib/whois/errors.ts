export type LookupErrorCode =
  | "INVALID_QUERY"
  | "LOOKUP_FAILED"
  | "LOOKUP_TIMEOUT"
  | "UPSTREAM_RATE_LIMITED"
  | "BUSY";

export class LookupError extends Error {
  constructor(
    public readonly code: LookupErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LookupError";
  }
}

export function upstreamError(
  error: unknown,
  signal: AbortSignal,
): LookupError {
  if (error instanceof LookupError) return error;
  if (
    signal.aborted ||
    (error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name))
  ) {
    return new LookupError("LOOKUP_TIMEOUT", "The lookup timed out.");
  }
  return new LookupError(
    "LOOKUP_FAILED",
    "The registration server could not complete the lookup.",
  );
}

export function isTerminalError(error: unknown): error is LookupError {
  return (
    error instanceof LookupError &&
    ["BUSY", "UPSTREAM_RATE_LIMITED"].includes(error.code)
  );
}
