/**
 * Local auth bootstrap for the same-origin API.
 *
 * The backend issues a per-install token at `GET /api/auth/token` (served only
 * to loopback clients). After fetching it once on startup we wrap `window.fetch`
 * so every same-origin `/api/*` request carries `Authorization: Bearer <token>`.
 *
 * When the backend has no token configured (unit/e2e test servers) the endpoint
 * returns an empty token and the wrapper becomes a no-op — requests still work
 * because the server only enforces the token when one is configured.
 */

let token = '';
let installed = false;
const originalFetch: typeof fetch = window.fetch;
const rawFetch: typeof fetch = originalFetch.bind(window) as typeof fetch;

function isSameOriginApi(url: string): boolean {
  if (url.startsWith('/api/') || url === '/api') return true;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api');
  } catch {
    return false;
  }
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function install(): void {
  if (installed) return;
  installed = true;

  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!token || !isSameOriginApi(resolveUrl(input))) {
      return rawFetch(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return rawFetch(input, { ...init, headers });
  };

  // Preserve `fetch.preconnect` so the wrapper matches the `typeof fetch` shape.
  window.fetch = Object.assign(wrapped, {
    preconnect: originalFetch.preconnect?.bind(window),
  }) as typeof fetch;
}

/**
 * Fetch the local auth token (if any) and install the authorized-fetch wrapper.
 * Always resolves — failures fall back to unauthenticated fetch.
 */
export async function bootstrapAuth(): Promise<void> {
  try {
    const res = await rawFetch('/api/auth/token', { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      token = data.token ?? '';
    }
  } catch {
    // No token endpoint (older server) or network error — proceed unauthenticated.
  }
  install();
}
