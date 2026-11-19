import { describe, expect, test } from 'bun:test';
import {
  buildDeepLinkPath,
  buildDeepLinkSearch,
  buildDeepLinkUrl,
  parseDeepLink,
  parseMessageId,
  sameDeepLinkTarget,
} from './deep-link';

describe('parseDeepLink', () => {
  test('legacy and canonical ?card= link', () => {
    expect(parseDeepLink('?card=V1StGXR8_Z5jdHi6B-myT')).toEqual({ kind: 'card', cardId: 'V1StGXR8_Z5jdHi6B-myT' });
  });

  test('nanoid ids that start with - or _ are valid', () => {
    expect(parseDeepLink('?card=-gJGDfAnvD2ehJ8ek5Qui')).toEqual({ kind: 'card', cardId: '-gJGDfAnvD2ehJ8ek5Qui' });
    expect(parseDeepLink('?session=s&msg=_abc%3Auser')).toEqual({ kind: 'session', sessionId: 's', message: { cardId: '_abc', role: 'user' } });
    expect(parseDeepLink('?card=.hidden').kind).toBe('invalid');
  });

  test('session with and without a message', () => {
    expect(parseDeepLink('?session=claude-abc')).toEqual({ kind: 'session', sessionId: 'claude-abc' });
    expect(parseDeepLink('?session=ses_1&msg=card1%3Aassistant')).toEqual({
      kind: 'session',
      sessionId: 'ses_1',
      message: { cardId: 'card1', role: 'assistant' },
    });
  });

  test('no link params → none; unrelated params ignored', () => {
    expect(parseDeepLink('')).toEqual({ kind: 'none' });
    expect(parseDeepLink('?foo=bar')).toEqual({ kind: 'none' });
  });

  test('malformed links are reported, not silently dropped', () => {
    expect(parseDeepLink('?card=').kind).toBe('invalid');
    expect(parseDeepLink('?card=%3Cscript%3E').kind).toBe('invalid');
    expect(parseDeepLink('?card=a&session=b').kind).toBe('invalid');
    expect(parseDeepLink('?msg=a%3Auser').kind).toBe('invalid');
    expect(parseDeepLink('?session=s&msg=a%3Asystem').kind).toBe('invalid');
    expect(parseDeepLink('?session=s&msg=nocolon').kind).toBe('invalid');
  });
});

describe('parseMessageId', () => {
  test('splits on the last colon and only accepts known roles', () => {
    expect(parseMessageId('abc:user')).toEqual({ cardId: 'abc', role: 'user' });
    expect(parseMessageId(':user')).toBeNull();
    expect(parseMessageId('abc:')).toBeNull();
  });
});

describe('buildDeepLinkSearch', () => {
  test('replaces only the link keys and keeps other params', () => {
    expect(buildDeepLinkSearch('?foo=1&card=old', { kind: 'session', sessionId: 's1' })).toBe('?foo=1&session=s1');
    expect(buildDeepLinkSearch('?card=old', null)).toBe('');
    expect(buildDeepLinkSearch('', { kind: 'session', sessionId: 's1', message: { cardId: 'c1', role: 'user' } }))
      .toBe('?session=s1&msg=c1%3Auser');
  });

  test('round-trips through parseDeepLink', () => {
    const target = { kind: 'session' as const, sessionId: 'claude-1', message: { cardId: 'c_1', role: 'assistant' as const } };
    expect(parseDeepLink(buildDeepLinkSearch('', target))).toEqual(target);
  });

  test('absolute URL and path forms', () => {
    expect(buildDeepLinkUrl({ origin: 'http://127.0.0.1:24680', pathname: '/' }, { kind: 'card', cardId: 'abc' }))
      .toBe('http://127.0.0.1:24680/?card=abc');
    expect(buildDeepLinkPath({ pathname: '/', search: '?card=a', hash: '#x' }, null)).toBe('/#x');
  });
});

describe('sameDeepLinkTarget', () => {
  test('compares kind, ids and message', () => {
    expect(sameDeepLinkTarget(null, null)).toBe(true);
    expect(sameDeepLinkTarget({ kind: 'card', cardId: 'a' }, { kind: 'card', cardId: 'a' })).toBe(true);
    expect(sameDeepLinkTarget({ kind: 'card', cardId: 'a' }, { kind: 'session', sessionId: 'a' })).toBe(false);
    expect(sameDeepLinkTarget(
      { kind: 'session', sessionId: 's', message: { cardId: 'c', role: 'user' } },
      { kind: 'session', sessionId: 's', message: { cardId: 'c', role: 'assistant' } },
    )).toBe(false);
  });
});
