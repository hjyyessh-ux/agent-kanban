/**
 * Formatting helpers shared by the Capabilities views and their detail dialogs.
 */

export function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---`) so the preview renders
 * the SKILL.md body as markdown instead of dumping raw `name:`/`description:`
 * lines. Editing keeps the full content (frontmatter included).
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
}

function maskSecret(val: string): string {
  if (val.length <= 8) return '***';
  return val.slice(0, 4) + '***' + val.slice(-4);
}

export function maskSecretDef(def: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...def };
  if (result.env && typeof result.env === 'object') {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.env as Record<string, string>)) {
      masked[k] = typeof v === 'string' && v.length > 12 ? maskSecret(v) : v;
    }
    result.env = masked;
  }
  if (result.headers && typeof result.headers === 'object') {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.headers as Record<string, string>)) {
      if (/auth|token|key|secret/i.test(k) && typeof v === 'string' && v.length > 12) {
        masked[k] = maskSecret(v);
      } else {
        masked[k] = v;
      }
    }
    result.headers = masked;
  }
  return result;
}
