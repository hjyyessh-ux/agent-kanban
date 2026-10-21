import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdChip, IdText, ResumeCopyButton } from './IdChip';
import { formatShortId } from '../../utils/short-id';

describe('IdChip', () => {
  test('shows # + 8 chars and names the full id it copies', () => {
    const html = renderToStaticMarkup(<IdChip id="24b90f31-19d5-4ac5-bea0-1372b9c64a05" kind="session" />);
    expect(html).toContain('<button type="button" class="kv2-id-chip"');
    expect(html).toContain('>#24b90f31</span>');
    expect(html).toContain('title="Session ID 복사: 24b90f31-19d5-4ac5-bea0-1372b9c64a05"');
    expect(html).not.toContain('kv2-id-chip-kind');
  });

  test('showKind prefixes the CARD/SESSION/WORK label', () => {
    const html = renderToStaticMarkup(<IdChip id="w8k2m1aa-xyz" kind="work" showKind />);
    expect(html).toContain('<span class="kv2-id-chip-kind">Work</span>');
    expect(html).toContain('>#w8k2m1aa</span>');
  });

  test('IdText renders the same short form without a button (for ids inside clickable rows)', () => {
    const html = renderToStaticMarkup(<IdText id="QYd7Jm0Ob-6tdX" kind="card" />);
    expect(html).not.toContain('<button');
    expect(html).toContain('kv2-id-chip--static');
    expect(html).toContain('>#QYd7Jm0O</span>');
  });

  test('ResumeCopyButton is a separate control naming the command', () => {
    const html = renderToStaticMarkup(<ResumeCopyButton command="claude --resume 'abc'" />);
    expect(html).toContain('⏎ resume');
    expect(html).toContain('aria-label="resume 명령 복사"');
  });

  test('formatShortId never pads short ids', () => {
    expect(formatShortId('abc')).toBe('#abc');
    expect(formatShortId('0123456789')).toBe('#01234567');
  });
});
