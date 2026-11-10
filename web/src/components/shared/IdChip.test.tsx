import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdChip, IdText, ResumeCopyButton, SessionResumeChip, stopKey } from './IdChip';
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

describe('stopKey', () => {
  const press = (key: string) => {
    let stopped = false;
    stopKey({ key, stopPropagation: () => { stopped = true; } });
    return stopped;
  };

  test('stops Enter/Space so a chip press does not also open its card', () => {
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
  });

  test('lets Escape through so a dialog focused on its IdChip still closes', () => {
    expect(press('Escape')).toBe(false);
    expect(press('Tab')).toBe(false);
  });
});

describe('SessionResumeChip', () => {
  test('shows the short session id with a ⏎ mark and names the resume command it copies', () => {
    const html = renderToStaticMarkup(
      <SessionResumeChip sessionId="24b90f31-19d5-4ac5-bea0-1372b9c64a05" command="claude --resume 'abc'" />,
    );
    expect(html).toContain('class="kv2-id-chip kv2-id-chip--resume"');
    expect(html).toContain('>#24b90f31</span>');
    expect(html).toContain('<span class="kv2-id-chip-resume" aria-hidden="true">⏎</span>');
    expect(html).toContain('aria-label="Session 24b90f31-19d5-4ac5-bea0-1372b9c64a05 resume 명령 복사"');
    expect(html).toContain("claude --resume &#x27;abc&#x27;");
  });
});
