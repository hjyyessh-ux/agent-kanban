import { describe, test, expect } from 'bun:test';
import { isValidCron, parseNaturalLanguageToCron, describeCron } from '../core/cron-parser';

describe('isValidCron', () => {
  test('accepts standard 5-field expression: * * * * *', () => {
    expect(isValidCron('* * * * *')).toBe(true);
  });

  test('accepts step expression: */5 * * * *', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
  });

  test('accepts specific time: 0 9 * * 1-5', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
  });

  test('accepts day-of-month: 30 14 1 * *', () => {
    expect(isValidCron('30 14 1 * *')).toBe(true);
  });

  test('accepts Sunday: 0 0 * * 0', () => {
    expect(isValidCron('0 0 * * 0')).toBe(true);
  });

  test('accepts ranges: 1-5 * * * *', () => {
    expect(isValidCron('1-5 * * * *')).toBe(true);
  });

  test('accepts lists: 1,2,3 * * * *', () => {
    expect(isValidCron('1,2,3 * * * *')).toBe(true);
  });

  test('accepts step with divisor: */10 * * * *', () => {
    expect(isValidCron('*/10 * * * *')).toBe(true);
  });

  test('accepts 6-field expression', () => {
    expect(isValidCron('0 0 1 1 * 2025')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidCron('')).toBe(false);
  });

  test('rejects too few fields (3 fields)', () => {
    expect(isValidCron('* * *')).toBe(false);
  });

  test('rejects too many fields (7 fields)', () => {
    expect(isValidCron('* * * * * * *')).toBe(false);
  });

  test('rejects alphabetic characters: a b c d e', () => {
    expect(isValidCron('a b c d e')).toBe(false);
  });

  test('rejects special characters', () => {
    expect(isValidCron('@ # $ % ^')).toBe(false);
  });

  test('rejects 4-field expression', () => {
    expect(isValidCron('* * * *')).toBe(false);
  });
});

describe('parseNaturalLanguageToCron', () => {
  // Korean patterns
  test('parses Korean: 5분마다 → */5 * * * *', () => {
    const result = parseNaturalLanguageToCron('5분마다');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('*/5 * * * *');
  });

  test('parses Korean: 매 10분마다 → */10 * * * *', () => {
    const result = parseNaturalLanguageToCron('매 10분마다');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('*/10 * * * *');
  });

  test('parses Korean: 2시간마다 → 0 */2 * * *', () => {
    const result = parseNaturalLanguageToCron('2시간마다');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 */2 * * *');
  });

  test('parses Korean: 매분 → * * * * *', () => {
    const result = parseNaturalLanguageToCron('매분');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('* * * * *');
  });

  test('parses Korean: 매시간 → 0 * * * *', () => {
    const result = parseNaturalLanguageToCron('매시간');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 * * * *');
  });

  test('parses Korean: 매일 9:30 → 30 9 * * *', () => {
    const result = parseNaturalLanguageToCron('매일 9:30');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('30 9 * * *');
  });

  test('parses Korean: 매일 9시 30분 → 30 9 * * *', () => {
    const result = parseNaturalLanguageToCron('매일 9시 30분');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('30 9 * * *');
  });

  test('parses Korean: 평일 → 0 9 * * 1-5', () => {
    const result = parseNaturalLanguageToCron('평일');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 1-5');
  });

  test('parses Korean: 월요일 → 0 9 * * 1', () => {
    const result = parseNaturalLanguageToCron('월요일');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 1');
  });

  test('parses Korean: 일요일 → 0 9 * * 0', () => {
    const result = parseNaturalLanguageToCron('일요일');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 0');
  });

  // English patterns
  test('parses English: every 5 minutes → */5 * * * *', () => {
    const result = parseNaturalLanguageToCron('every 5 minutes');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('*/5 * * * *');
  });

  test('parses English: every 2 hours → 0 */2 * * *', () => {
    const result = parseNaturalLanguageToCron('every 2 hours');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 */2 * * *');
  });

  test('parses English: every minute → * * * * *', () => {
    const result = parseNaturalLanguageToCron('every minute');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('* * * * *');
  });

  test('parses English: every hour → 0 * * * *', () => {
    const result = parseNaturalLanguageToCron('every hour');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 * * * *');
  });

  test('parses English: every day at 14:30 → 30 14 * * *', () => {
    const result = parseNaturalLanguageToCron('every day at 14:30');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('30 14 * * *');
  });

  test('parses English: every weekday → 0 9 * * 1-5', () => {
    const result = parseNaturalLanguageToCron('every weekday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 1-5');
  });

  test('parses English: every monday → 0 9 * * 1', () => {
    const result = parseNaturalLanguageToCron('every monday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 1');
  });

  test('parses English: every sunday → 0 9 * * 0', () => {
    const result = parseNaturalLanguageToCron('every sunday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 0');
  });

  test('parses English: at 08:00 → 0 8 * * *', () => {
    const result = parseNaturalLanguageToCron('at 08:00');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 8 * * *');
  });

  // Raw cron pass-through
  test('passes through raw cron: */5 * * * *', () => {
    const result = parseNaturalLanguageToCron('*/5 * * * *');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('*/5 * * * *');
    expect(result!.description).toBe('*/5 * * * *');
  });

  // Null returns
  test('returns null for empty string', () => {
    expect(parseNaturalLanguageToCron('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseNaturalLanguageToCron('   ')).toBeNull();
  });

  test('returns null for unrecognized text', () => {
    expect(parseNaturalLanguageToCron('do something')).toBeNull();
  });

  test('returns null for sub-minute: every 30 seconds', () => {
    expect(parseNaturalLanguageToCron('every 30 seconds')).toBeNull();
  });

  test('returns null for sub-minute: 30초마다', () => {
    expect(parseNaturalLanguageToCron('30초마다')).toBeNull();
  });

  // All English day names
  test('parses every tuesday → 0 9 * * 2', () => {
    const result = parseNaturalLanguageToCron('every tuesday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 2');
  });

  test('parses every wednesday → 0 9 * * 3', () => {
    const result = parseNaturalLanguageToCron('every wednesday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 3');
  });

  test('parses every thursday → 0 9 * * 4', () => {
    const result = parseNaturalLanguageToCron('every thursday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 4');
  });

  test('parses every friday → 0 9 * * 5', () => {
    const result = parseNaturalLanguageToCron('every friday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 5');
  });

  test('parses every saturday → 0 9 * * 6', () => {
    const result = parseNaturalLanguageToCron('every saturday');
    expect(result).not.toBeNull();
    expect(result!.cron).toBe('0 9 * * 6');
  });
});

describe('describeCron', () => {
  test('describes * * * * * as Every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
  });

  test('describes */5 * * * * as Every 5 minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
  });

  test('describes 0 */2 * * * as Every 2 hours', () => {
    expect(describeCron('0 */2 * * *')).toBe('Every 2 hours');
  });

  test('describes 0 * * * * as Every hour', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour');
  });

  test('describes 30 9 * * * as Every day at 09:30', () => {
    expect(describeCron('30 9 * * *')).toBe('Every day at 09:30');
  });

  test('describes 0 9 * * 1-5 as Every weekday at 09:00', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Every weekday at 09:00');
  });

  test('describes 0 9 * * 1 as Every Monday at 09:00', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00');
  });

  test('describes 0 9 * * 0 as Every Sunday at 09:00', () => {
    expect(describeCron('0 9 * * 0')).toBe('Every Sunday at 09:00');
  });

  test('describes all weekday names correctly', () => {
    expect(describeCron('0 9 * * 2')).toBe('Every Tuesday at 09:00');
    expect(describeCron('0 9 * * 3')).toBe('Every Wednesday at 09:00');
    expect(describeCron('0 9 * * 4')).toBe('Every Thursday at 09:00');
    expect(describeCron('0 9 * * 5')).toBe('Every Friday at 09:00');
    expect(describeCron('0 9 * * 6')).toBe('Every Saturday at 09:00');
  });

  test('pads single-digit hours and minutes', () => {
    expect(describeCron('5 8 * * *')).toBe('Every day at 08:05');
  });

  test('returns raw cron string for unrecognized patterns', () => {
    const complex = '0 0 1 1 *';
    expect(describeCron(complex)).toBe(complex);
  });

  test('returns raw cron for expressions with less than 5 fields', () => {
    expect(describeCron('* * *')).toBe('* * *');
  });

  test('falls back to raw cron for complex month/day patterns', () => {
    const raw = '0 0 */3 */2 *';
    expect(describeCron(raw)).toBe(raw);
  });
});
