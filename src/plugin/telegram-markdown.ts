/**
 * Agent results are GitHub-flavored Markdown, but Telegram renders neither GFM
 * tables nor `#` headings, and its own Markdown parse modes reject any
 * unbalanced marker. Translate to the small HTML subset Telegram accepts
 * (b/i/s/code/pre/a/blockquote) and lay tables out as monospace text.
 *
 * Rendering works on self-contained blocks (a line, a whole `<pre>`, a whole
 * blockquote) so messages can be split between blocks without ever cutting an
 * HTML tag in half.
 */

/** Raw characters per rendered chunk. Escaping can grow text ~5x (`&` → `&amp;`). */
const RAW_CHUNK = 700;
/** Escaped characters per `<pre>` chunk, leaving room for tags and the part prefix. */
const PRE_CHUNK = 3500;
/** Tables wider than this read better on a phone as one record per row. */
const MAX_TABLE_WIDTH = 44;

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain-text fallback for a rendered part Telegram refused to parse. */
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function renderEmphasis(text: string): string {
  return escapeTelegramHtml(text)
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_match, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
    )
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    // `_x_` is left alone on purpose: snake_case identifiers are far more
    // common in agent output than underscore italics.
    .replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![*\w])/g, '<i>$1</i>');
}

function renderInline(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const index = match.index ?? 0;
    out.push(renderEmphasis(text.slice(last, index)));
    out.push(`<code>${escapeTelegramHtml(match[1])}</code>`);
    last = index + match[0].length;
  }
  out.push(renderEmphasis(text.slice(last)));
  return out.join('');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '');
}

function chunkRaw(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}

function preBlocks(lines: string[], language?: string): string[] {
  const open = language ? `<pre><code class="language-${escapeTelegramHtml(language)}">` : '<pre>';
  const close = language ? '</code></pre>' : '</pre>';
  const blocks: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length > 0) blocks.push(`${open}${current.join('\n')}${close}`);
    current = [];
    size = 0;
  };
  for (const line of lines) {
    for (const piece of chunkRaw(line, RAW_CHUNK)) {
      const escaped = escapeTelegramHtml(piece);
      if (size + escaped.length + 1 > PRE_CHUNK) flush();
      current.push(escaped);
      size += escaped.length + 1;
    }
  }
  flush();
  return blocks.length > 0 ? blocks : [`${open}${close}`];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isWide(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** Monospace columns: CJK and emoji take two cells, joiners and selectors none. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => stripInlineMarkdown(cell.trim().replace(/\\\|/g, '|')));
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return header !== undefined
    && separator !== undefined
    && header.includes('|')
    && separator.includes('-')
    && separator.includes('|')
    && TABLE_SEPARATOR.test(separator);
}

function renderTable(headerLine: string, separatorLine: string, rowLines: string[]): string[] {
  const header = splitTableRow(headerLine);
  const rightAligned = splitTableRow(separatorLine).map(cell => /-:$/.test(cell));
  const columnCount = header.length;
  const rows = rowLines.map(line => {
    const cells = splitTableRow(line);
    return Array.from({ length: columnCount }, (_, column) => cells[column] ?? '');
  });

  const widths = header.map((cell, column) =>
    Math.max(displayWidth(cell), ...rows.map(row => displayWidth(row[column]))));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + (columnCount - 1) * 3;

  if (totalWidth > MAX_TABLE_WIDTH && columnCount > 1) {
    // One record per row: the first column as a title, the rest as fields.
    return rows.flatMap((row, index) => [
      ...(index > 0 ? [''] : []),
      `<b>${escapeTelegramHtml(row[0] || '-')}</b>`,
      ...row.slice(1).map((cell, offset) =>
        `  ${escapeTelegramHtml(header[offset + 1])}: ${escapeTelegramHtml(cell)}`),
    ]);
  }

  const pad = (cell: string, column: number) => {
    const fill = ' '.repeat(Math.max(0, widths[column] - displayWidth(cell)));
    return rightAligned[column] ? fill + cell : cell + fill;
  };
  const format = (cells: string[]) => cells.map(pad).join(' │ ').trimEnd();
  return preBlocks([
    format(header),
    widths.map(width => '─'.repeat(width)).join('─┼─'),
    ...rows.map(format),
  ]);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function renderLine(line: string): string[] {
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
  if (heading) return [`<b>${renderInline(heading[1])}</b>`];

  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return ['──────────'];

  const bullet = line.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/);
  if (bullet) {
    const [, indent, task, body] = bullet;
    const marker = task === undefined ? '•' : task === ' ' ? '☐' : '☑';
    return chunkRaw(body, RAW_CHUNK).map((piece, index) =>
      index === 0 ? `${indent}${marker} ${renderInline(piece)}` : renderInline(piece));
  }

  return chunkRaw(line, RAW_CHUNK).map(renderInline);
}

/** Render Markdown into self-contained Telegram HTML blocks, one per line or element. */
export function markdownToTelegramHtmlBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push(...preBlocks(body, fence[2] || undefined));
      continue;
    }

    if (isTableStart(lines, index)) {
      const headerLine = line;
      const separatorLine = lines[index + 1];
      const rowLines: string[] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rowLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      blocks.push(...renderTable(headerLine, separatorLine, rowLines));
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      index -= 1;
      // Keep each blockquote small enough to fit a message on its own.
      let current: string[] = [];
      let size = 0;
      const flush = () => {
        if (current.length > 0) blocks.push(`<blockquote>${current.join('\n')}</blockquote>`);
        current = [];
        size = 0;
      };
      for (const quotedLine of quoted) {
        for (const rendered of renderLine(quotedLine)) {
          if (size + rendered.length + 1 > PRE_CHUNK) flush();
          current.push(rendered);
          size += rendered.length + 1;
        }
      }
      flush();
      continue;
    }

    blocks.push(...renderLine(line));
  }

  return blocks;
}

/**
 * Render Markdown into Telegram HTML message parts no longer than `limit`,
 * numbered `(i/n)` when there is more than one. Splits only between blocks.
 */
export function renderTelegramHtmlParts(markdown: string, limit: number, prefixBudget: number): string[] {
  const budget = limit - prefixBudget;
  const parts: string[] = [];
  let current: string | undefined;

  for (const block of markdownToTelegramHtmlBlocks(markdown)) {
    const candidate = current === undefined ? block : `${current}\n${block}`;
    if (candidate.length <= budget || current === undefined) {
      current = candidate;
      continue;
    }
    parts.push(current);
    current = block;
  }
  if (current !== undefined) parts.push(current);

  const trimmed = parts.map(part => part.replace(/^\n+|\n+$/g, '')).filter(part => part.length > 0);
  if (trimmed.length <= 1) return trimmed.length === 1 ? trimmed : [''];
  return trimmed.map((part, index) => `(${index + 1}/${trimmed.length})\n${part}`);
}
