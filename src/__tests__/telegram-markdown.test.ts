import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
  markdownToTelegramHtmlBlocks,
  renderTelegramHtmlParts,
  telegramHtmlToPlain,
} from '../plugin/telegram-markdown';
import { sendTelegramMarkdown } from '../plugin/telegram-notifier';

describe('markdownToTelegramHtmlBlocks', () => {
  test('renders headings, emphasis, inline code, links, and bullets', () => {
    const html = markdownToTelegramHtmlBlocks([
      '## 결과',
      '- **bold** and `a<b>` with [docs](https://example.com/x)',
      '- [x] done',
      '1 < 2 & snake_case_name',
    ].join('\n')).join('\n');

    expect(html).toBe([
      '<b>결과</b>',
      '• <b>bold</b> and <code>a&lt;b&gt;</code> with <a href="https://example.com/x">docs</a>',
      '☑ done',
      '1 &lt; 2 &amp; snake_case_name',
    ].join('\n'));
  });

  test('lays a narrow table out as aligned monospace, counting Hangul as two cells', () => {
    const blocks = markdownToTelegramHtmlBlocks([
      '| 이름 | 값 |',
      '|---|---:|',
      '| api | 1 |',
      '| **워커** | 20 |',
    ].join('\n'));

    expect(blocks).toEqual([
      '<pre>이름 │ 값\n─────┼───\napi  │  1\n워커 │ 20</pre>',
    ]);
  });

  test('turns a table too wide for a phone into one record per row', () => {
    const blocks = markdownToTelegramHtmlBlocks([
      '| service | description | owner |',
      '|---|---|---|',
      '| api | handles every public request coming from the edge | platform |',
    ].join('\n'));

    expect(blocks).toEqual([
      '<b>api</b>',
      '  description: handles every public request coming from the edge',
      '  owner: platform',
    ]);
  });

  test('keeps fenced code verbatim and escaped', () => {
    const blocks = markdownToTelegramHtmlBlocks('```ts\nconst a = 1 < 2 && **x**;\n```');
    expect(blocks).toEqual(['<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **x**;</code></pre>']);
  });
});

describe('renderTelegramHtmlParts', () => {
  test('splits long output between blocks so every part has balanced tags', () => {
    const code = Array.from({ length: 400 }, (_, index) => `line ${index} <tag>`).join('\n');
    const parts = renderTelegramHtmlParts(`intro\n\`\`\`\n${code}\n\`\`\`\noutro`, 4096, 16);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.split('<pre>').length).toBe(part.split('</pre>').length);
    }
    expect(parts[0].startsWith(`(1/${parts.length})\nintro`)).toBe(true);
    expect(telegramHtmlToPlain(parts.join('\n'))).toContain('line 399 <tag>');
  });
});

describe('sendTelegramMarkdown', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('resends a part as plain text when Telegram cannot parse the HTML', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock(async (_url: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (body.parse_mode === 'HTML') {
        return new Response(JSON.stringify({
          ok: false,
          description: "Bad Request: can't parse entities: unexpected end tag",
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendTelegramMarkdown('token', 1, '**a *b** c*');

    expect(result).toEqual({ ok: true, messageId: 7 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].parse_mode).toBeUndefined();
    expect(bodies[1].text).not.toContain('<');
  });
});
