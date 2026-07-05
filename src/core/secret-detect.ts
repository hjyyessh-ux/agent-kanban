import type { McpServerDef } from './types';

const KNOWN_PREFIX = /^(sk-|ghp_|gho_|glp_|xoxb-|xoxp-|AIza|ya29\.|AKIA|nvapi-)/;
const LONG_TOKEN = /^[A-Za-z0-9+/=_\-]{40,}$/;

/**
 * Heuristically detect potential plaintext secrets in an MCP server definition.
 * Checks env values, embedded URL credentials, and auth headers.
 */
export function detectPlaintextSecret(def: McpServerDef): boolean {
  if (def.env) {
    for (const val of Object.values(def.env)) {
      if (typeof val === 'string' && (KNOWN_PREFIX.test(val) || LONG_TOKEN.test(val))) return true;
    }
  }

  if (def.url) {
    try {
      const u = new URL(def.url as string);
      if (u.username || u.password) return true;
    } catch { /* ignore */ }
  }

  if (def.headers) {
    for (const [key, val] of Object.entries(def.headers as Record<string, string>)) {
      if (/auth|token|key|secret/i.test(key)) {
        const stripped = val.replace(/^(bearer|token|basic)\s+/i, '');
        if (KNOWN_PREFIX.test(stripped) || LONG_TOKEN.test(stripped)) return true;
      }
    }
  }

  return false;
}
