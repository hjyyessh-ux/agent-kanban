import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchWithRetry, type RetryOptions } from '../core/retry';

// ─── Helpers ──────────────────────────────────────────────────────

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = mock(fn) as unknown as typeof fetch;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  const fastOptions: Partial<RetryOptions> = {
    baseDelayMs: 1, // near-instant for tests
  };

  test('returns successful response without retrying', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return jsonResponse(200, { ok: true });
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(200);
    expect(callCount).toBe(1);

    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  test('returns non-retryable error immediately (no retry)', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return jsonResponse(400, { error: 'bad request' });
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(400);
    expect(callCount).toBe(1);
  });

  test('retries on 429 and eventually succeeds', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount <= 2) return jsonResponse(429);
      return jsonResponse(200, { success: true });
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(200);
    expect(callCount).toBe(3);
  });

  test('retries on 500 and eventually succeeds', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(500);
      return jsonResponse(200);
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test('retries on 503 and eventually succeeds', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(503);
      return jsonResponse(200);
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test('returns last retryable response after exhausting retries', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return jsonResponse(429);
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, {
      ...fastOptions,
      maxRetries: 2,
    });
    expect(res.status).toBe(429);
    // initial + 2 retries = 3 calls
    expect(callCount).toBe(3);
  });

  test('retries on network error and eventually succeeds', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNREFUSED');
      return jsonResponse(200);
    });

    const res = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test('throws after exhausting retries on network error', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      throw new Error('ECONNREFUSED');
    });

    await expect(
      fetchWithRetry('https://example.com/api', undefined, {
        ...fastOptions,
        maxRetries: 2,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    // initial + 2 retries = 3 calls
    expect(callCount).toBe(3);
  });

  test('calls onRetry callback before each retry', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount <= 2) return jsonResponse(500);
      return jsonResponse(200);
    });

    const retryCalls: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const onRetry = (attempt: number, delayMs: number, reason: string) => {
      retryCalls.push({ attempt, delayMs, reason });
    };

    await fetchWithRetry('https://example.com/api', undefined, {
      ...fastOptions,
      onRetry,
    });

    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]!.attempt).toBe(1);
    expect(retryCalls[0]!.reason).toBe('HTTP 500');
    expect(retryCalls[1]!.attempt).toBe(2);
    expect(retryCalls[1]!.reason).toBe('HTTP 500');
  });

  test('respects custom retryableStatusCodes', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(418); // I'm a teapot
      return jsonResponse(200);
    });

    // 418 not in default retryable codes — should NOT retry
    const res1 = await fetchWithRetry('https://example.com/api', undefined, fastOptions);
    expect(res1.status).toBe(418);
    expect(callCount).toBe(1);

    // Reset with 418 as retryable
    callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(418);
      return jsonResponse(200);
    });

    const res2 = await fetchWithRetry('https://example.com/api', undefined, {
      ...fastOptions,
      retryableStatusCodes: [418],
    });
    expect(res2.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test('passes through RequestInit options to fetch', async () => {
    const capturedUrls: string[] = [];
    const capturedInits: Array<RequestInit | undefined> = [];
    mockFetch(async (url, init) => {
      capturedUrls.push(String(url));
      capturedInits.push(init);
      return jsonResponse(200);
    });

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'test' }),
    };

    await fetchWithRetry('https://example.com/api', init, fastOptions);
    expect(capturedUrls[0]).toBe('https://example.com/api');
    expect(capturedInits[0]).toEqual(init);
  });

  test('exponential backoff increases delay between retries', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount <= 3) return jsonResponse(500);
      return jsonResponse(200);
    });

    const delays: number[] = [];
    const onRetry = (_attempt: number, delayMs: number, _reason: string) => {
      delays.push(delayMs);
    };

    await fetchWithRetry('https://example.com/api', undefined, {
      baseDelayMs: 100,
      maxRetries: 3,
      onRetry,
    });

    // Exponential: 100 * 2^0 = 100, 100 * 2^1 = 200, 100 * 2^2 = 400
    expect(delays).toEqual([100, 200, 400]);
  });
});
