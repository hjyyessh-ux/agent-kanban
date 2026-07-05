import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import type { WikiDocType } from '../../core/types';
import type { ClassifyResult } from './wiki-prompts';

export interface WikiDocMeta {
  cardIds: string[];
  sessionId?: string;
  sessionTitle?: string;
  projectDir?: string;
  processedAt: string;
  promptVersion: number;
  sourceDepth: 'card' | 'transcript';
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'untitled';
}

/** One index.md catalog row. `processed`/`topics` enable index-only search. */
export interface WikiIndexEntry {
  docPath: string;
  title: string;
  type: WikiDocType;
  summary: string;
  /** ISO processed timestamp; only the YYYY-MM-DD prefix is shown. */
  processed?: string;
  topics?: string[];
}

/**
 * Render a single index.md row. Date + topics are appended as backtick tokens
 * (not Obsidian `#tags`) so the catalog stays grep/index-searchable by date and
 * topic without flooding the vault-wide tag pane. Shared by the live writer and
 * the offline reindex script so both emit byte-identical lines.
 */
export function buildIndexLine(entry: WikiIndexEntry): string {
  const link = entry.docPath.replace(/\.md$/, '');
  const date = entry.processed?.slice(0, 10) ?? '';
  const tags = (entry.topics ?? []).map(t => `\`${t}\``).join(' ');
  const meta = [`\`${entry.type}\``, date && `\`${date}\``, tags].filter(Boolean).join(' ');
  return `- [[${link}|${entry.title}]] ${meta}${entry.summary ? ` — ${entry.summary}` : ''}`;
}

/**
 * Writes wiki documents into the Obsidian vault wiki directory and keeps
 * `index.md` / `log.md` up to date. Paths returned are vault-relative.
 */
export class WikiVaultWriter {
  constructor(private readonly vaultDir: string) {}

  ensureVaultDir(): void {
    mkdirSync(this.vaultDir, { recursive: true });
  }

  /**
   * Read a generated document by its vault-relative path for the UI preview.
   * Strips the YAML frontmatter so the body renders cleanly. Returns null if the
   * resolved path escapes the vault (traversal guard) or the file is missing.
   */
  readDocument(relPath: string): string | null {
    const base = resolve(this.vaultDir);
    const abs = resolve(base, relPath);
    if (abs !== base && !abs.startsWith(base + sep)) return null;
    if (!abs.endsWith('.md') || !existsSync(abs)) return null;
    const raw = readFileSync(abs, 'utf-8');
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim();
  }

  /** Write (or overwrite, when reprocessing) a wiki document. */
  async writeDocument(doc: ClassifyResult, meta: WikiDocMeta, overwritePath?: string): Promise<string> {
    const relPath = overwritePath ?? this.uniqueDocPath(doc.type, doc.slug);
    const absPath = join(this.vaultDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const frontmatter = [
      '---',
      `title: "${escapeYaml(doc.title)}"`,
      `type: ${doc.type}`,
      `topics: [${doc.topics.map(t => `"${escapeYaml(t)}"`).join(', ')}]`,
      `cards: [${meta.cardIds.map(id => `"${id}"`).join(', ')}]`,
      ...(meta.sessionId ? [`session: "${escapeYaml(meta.sessionId)}"`] : []),
      ...(meta.sessionTitle ? [`session_title: "${escapeYaml(meta.sessionTitle)}"`] : []),
      ...(meta.projectDir ? [`project: "${escapeYaml(meta.projectDir)}"`] : []),
      `processed: ${meta.processedAt}`,
      `prompt_version: ${meta.promptVersion}`,
      `source_depth: ${meta.sourceDepth}`,
      'source: agent-kanban',
      '---',
    ].join('\n');

    const summaryBlock = doc.summary ? `> ${doc.summary}\n\n` : '';
    await Bun.write(absPath, `${frontmatter}\n\n# ${doc.title}\n\n${summaryBlock}${doc.body.trim()}\n`);
    return relPath;
  }

  /** Upsert a document line in index.md (deduped by doc link). */
  async updateIndex(entry: WikiIndexEntry): Promise<void> {
    const indexPath = join(this.vaultDir, 'index.md');
    const link = entry.docPath.replace(/\.md$/, '');
    const line = buildIndexLine(entry);

    let lines: string[];
    if (existsSync(indexPath)) {
      lines = readFileSync(indexPath, 'utf-8').trimEnd().split('\n');
    } else {
      lines = ['# Agent Kanban Wiki Index', ''];
    }

    const linkKey = `[[${link}|`;
    const filtered = lines.filter(l => !l.includes(linkKey));
    filtered.push(line);
    await Bun.write(indexPath, `${filtered.join('\n')}\n`);
  }

  /** Append a processing record to log.md (Karpathy-style run log). */
  async appendLog(line: string): Promise<void> {
    const logPath = join(this.vaultDir, 'log.md');
    const existing = existsSync(logPath)
      ? readFileSync(logPath, 'utf-8').trimEnd()
      : '# Wiki Processing Log';
    await Bun.write(logPath, `${existing}\n${line}\n`);
  }

  private uniqueDocPath(type: WikiDocType, slug: string): string {
    const base = sanitizeSlug(slug);
    let candidate = `${type}/${base}.md`;
    let n = 2;
    while (existsSync(join(this.vaultDir, candidate))) {
      candidate = `${type}/${base}-${n}.md`;
      n++;
    }
    return candidate;
  }
}
