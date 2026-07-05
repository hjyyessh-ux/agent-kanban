/**
 * Reusable fetch-with-retry utility with exponential backoff.
 * Retries on transient HTTP errors (429, 500, 503) and network failures.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds before first retry (default: 1000) */
  baseDelayMs: number;
  /** HTTP status codes that trigger a retry (default: [429, 500, 503]) */
  retryableStatusCodes: number[];
  /** Optional callback invoked before each retry */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatusCodes: [429, 500, 503],
};

/**
 * Wrapper around `fetch` that retries on transient failures.
 *
 * - Retryable HTTP status codes trigger a retry with exponential backoff.
 * - Network errors (fetch throws) also trigger retries.
 * - Non-retryable responses are returned immediately.
 * - On exhausted retries, returns the last response (for HTTP errors)
 *   or re-throws (for network errors).
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options?: Partial<RetryOptions>,
): Promise<Response> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(input, init);

      if (!opts.retryableStatusCodes.includes(response.status) || attempt === opts.maxRetries) {
        return response;
      }

      // Retryable status — wait and retry
      const delayMs = opts.baseDelayMs * Math.pow(2, attempt);
      opts.onRetry?.(attempt + 1, delayMs, `HTTP ${response.status}`);
      await sleep(delayMs);
    } catch (err: unknown) {
      lastError = err;

      if (attempt === opts.maxRetries) {
        throw err;
      }

      // Network error — wait and retry
      const delayMs = opts.baseDelayMs * Math.pow(2, attempt);
      const reason = err instanceof Error ? err.message : String(err);
      opts.onRetry?.(attempt + 1, delayMs, reason);
      await sleep(delayMs);
    }
  }

  // Should not reach here, but TypeScript needs it
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
