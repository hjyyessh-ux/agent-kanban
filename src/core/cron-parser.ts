/**
 * Natural language → cron expression converter.
 * Supports Korean and English patterns.
 *
 * Returns { cron, description } or null if no pattern matched.
 * Users can always provide raw cron expressions directly.
 */

export interface CronParseResult {
  cron: string;
  description: string;
}

interface PatternRule {
  pattern: RegExp;
  handler: (match: RegExpMatchArray) => CronParseResult | null;
}

// ─── Korean + English pattern rules ────────────────────────────────

const rules: PatternRule[] = [
  // "every N minutes" / "매 N분마다"
  {
    pattern: /^(?:매\s*)?(\d+)\s*분\s*(?:마다|간격)$/,
    handler: (m) => ({
      cron: `*/${m[1]} * * * *`,
      description: `매 ${m[1]}분마다`,
    }),
  },
  {
    pattern: /^every\s+(\d+)\s+minutes?$/i,
    handler: (m) => ({
      cron: `*/${m[1]} * * * *`,
      description: `Every ${m[1]} minutes`,
    }),
  },

  // "every N hours" / "매 N시간마다"
  {
    pattern: /^(?:매\s*)?(\d+)\s*시간\s*(?:마다|간격)$/,
    handler: (m) => ({
      cron: `0 */${m[1]} * * *`,
      description: `매 ${m[1]}시간마다`,
    }),
  },
  {
    pattern: /^every\s+(\d+)\s+hours?$/i,
    handler: (m) => ({
      cron: `0 */${m[1]} * * *`,
      description: `Every ${m[1]} hours`,
    }),
  },

  // "every minute" / "매분"
  {
    pattern: /^매\s*분$/,
    handler: () => ({
      cron: '* * * * *',
      description: '매분',
    }),
  },
  {
    pattern: /^every\s+minute$/i,
    handler: () => ({
      cron: '* * * * *',
      description: 'Every minute',
    }),
  },

  // "every hour" / "매시간" / "1시간마다"
  {
    pattern: /^(?:매\s*시간|매\s*시)$/,
    handler: () => ({
      cron: '0 * * * *',
      description: '매시간',
    }),
  },
  {
    pattern: /^every\s+hour$/i,
    handler: () => ({
      cron: '0 * * * *',
      description: 'Every hour',
    }),
  },

  // "every day at HH:MM" / "매일 HH:MM" / "매일 HH시 MM분"
  {
    pattern: /^매일\s+(\d{1,2})\s*[시:]\s*(\d{1,2})\s*분?$/,
    handler: (m) => ({
      cron: `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`,
      description: `매일 ${m[1]}시 ${m[2]}분`,
    }),
  },
  {
    pattern: /^매일\s+(\d{1,2}):(\d{2})$/,
    handler: (m) => ({
      cron: `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`,
      description: `매일 ${m[1]}:${m[2]}`,
    }),
  },
  {
    pattern: /^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/i,
    handler: (m) => ({
      cron: `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`,
      description: `Every day at ${m[1]}:${m[2]}`,
    }),
  },

  // "every weekday" / "매 평일"
  {
    pattern: /^(?:매\s*)?평일$/,
    handler: () => ({
      cron: '0 9 * * 1-5',
      description: '매 평일 09:00',
    }),
  },
  {
    pattern: /^every\s+weekday$/i,
    handler: () => ({
      cron: '0 9 * * 1-5',
      description: 'Every weekday at 09:00',
    }),
  },

  // "every monday" / "매주 월요일"
  {
    pattern: /^(?:매주\s*)?월요일$/,
    handler: () => ({ cron: '0 9 * * 1', description: '매주 월요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?화요일$/,
    handler: () => ({ cron: '0 9 * * 2', description: '매주 화요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?수요일$/,
    handler: () => ({ cron: '0 9 * * 3', description: '매주 수요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?목요일$/,
    handler: () => ({ cron: '0 9 * * 4', description: '매주 목요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?금요일$/,
    handler: () => ({ cron: '0 9 * * 5', description: '매주 금요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?토요일$/,
    handler: () => ({ cron: '0 9 * * 6', description: '매주 토요일 09:00' }),
  },
  {
    pattern: /^(?:매주\s*)?일요일$/,
    handler: () => ({ cron: '0 9 * * 0', description: '매주 일요일 09:00' }),
  },
  {
    pattern: /^every\s+monday$/i,
    handler: () => ({ cron: '0 9 * * 1', description: 'Every Monday at 09:00' }),
  },
  {
    pattern: /^every\s+tuesday$/i,
    handler: () => ({ cron: '0 9 * * 2', description: 'Every Tuesday at 09:00' }),
  },
  {
    pattern: /^every\s+wednesday$/i,
    handler: () => ({ cron: '0 9 * * 3', description: 'Every Wednesday at 09:00' }),
  },
  {
    pattern: /^every\s+thursday$/i,
    handler: () => ({ cron: '0 9 * * 4', description: 'Every Thursday at 09:00' }),
  },
  {
    pattern: /^every\s+friday$/i,
    handler: () => ({ cron: '0 9 * * 5', description: 'Every Friday at 09:00' }),
  },
  {
    pattern: /^every\s+saturday$/i,
    handler: () => ({ cron: '0 9 * * 6', description: 'Every Saturday at 09:00' }),
  },
  {
    pattern: /^every\s+sunday$/i,
    handler: () => ({ cron: '0 9 * * 0', description: 'Every Sunday at 09:00' }),
  },

  // "at HH:MM" / "HH시 MM분에"
  {
    pattern: /^(\d{1,2})\s*[시:]\s*(\d{1,2})\s*분?\s*에?$/,
    handler: (m) => ({
      cron: `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`,
      description: `매일 ${m[1]}시 ${m[2]}분`,
    }),
  },
  {
    pattern: /^at\s+(\d{1,2}):(\d{2})$/i,
    handler: (m) => ({
      cron: `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`,
      description: `Every day at ${m[1]}:${m[2]}`,
    }),
  },

  // "every N seconds" — not supported by cron, but handle with a message
  {
    pattern: /^(?:매\s*)?(\d+)\s*초\s*(?:마다|간격)$/,
    handler: () => null, // cron doesn't support sub-minute
  },
  {
    pattern: /^every\s+(\d+)\s+seconds?$/i,
    handler: () => null, // cron doesn't support sub-minute
  },
];

/**
 * Validate a 5-field cron expression loosely.
 * Returns true if the expression looks like valid cron.
 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;

  // Basic field validation (allows *, numbers, ranges, lists, steps)
  const fieldPattern = /^(\*|\d+)([/-]\d+)?([,]\d+([/-]\d+)?)*$/;
  return parts.slice(0, 5).every(part => fieldPattern.test(part));
}

/**
 * Parse natural language input to cron expression.
 * Returns CronParseResult if matched, null otherwise.
 *
 * Users can also pass raw cron expressions directly.
 */
export function parseNaturalLanguageToCron(input: string): CronParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If it looks like a raw cron expression, validate and return
  if (isValidCron(trimmed)) {
    return {
      cron: trimmed,
      description: trimmed, // raw cron as description — frontend will format
    };
  }

  // Try each NL rule
  for (const rule of rules) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      return rule.handler(match);
    }
  }

  return null;
}

/**
 * Generate a simple human-readable description from a cron expression.
 * This is a lightweight alternative to cronstrue (no dependency).
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every minute';
  }

  // Every N minutes
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${minute.slice(2)} minutes`;
  }

  // Every N hours
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${hour.slice(2)} hours`;
  }

  // Every hour
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every hour';
  }

  // Daily at specific time
  if (!minute.includes('*') && !hour.includes('*') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Weekdays
  if (!minute.includes('*') && !hour.includes('*') && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Every weekday at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Specific day of week
  const dayNames: Record<string, string> = {
    '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
    '4': 'Thursday', '5': 'Friday', '6': 'Saturday',
  };
  if (!minute.includes('*') && !hour.includes('*') && dayOfMonth === '*' && month === '*' && dayNames[dayOfWeek]) {
    return `Every ${dayNames[dayOfWeek]} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  return cron; // fallback: return raw expression
}
