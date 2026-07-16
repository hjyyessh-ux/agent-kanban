import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SchedulerEntry } from '../../../../src/core/types';
import { SchedulerView } from './SchedulerView';

const entry: SchedulerEntry = {
  id: 'scheduler-1',
  name: 'Daily digest',
  description: 'Summarize open work',
  cron: '0 9 * * 1-5',
  cronDescription: 'Weekdays at 9 AM',
  timezone: 'Asia/Seoul',
  status: 'active',
  action: { type: 'shell', command: 'bun scripts/digest.ts' },
  nextRunAt: '2026-07-17T00:00:00.000Z',
  history: [],
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
};

describe('SchedulerView readability', () => {
  test('renders visible context, status, and labeled schedule metadata', () => {
    const html = renderToStaticMarkup(
      <SchedulerView
        entries={[entry]}
        loading={false}
        error={null}
        onCreateEntry={async () => entry}
        onUpdateEntry={async () => {}}
        onDeleteEntry={async () => {}}
        onToggleEntry={async () => {}}
        onRunEntry={async () => {}}
        onRefresh={async () => {}}
        onClearError={() => {}}
      />,
    );

    expect(html).toContain('정해진 시간에 shell command나 skill을 자동으로 실행합니다');
    expect(html).toContain('자동 실행 중');
    expect(html).toContain('<strong>Schedule</strong>');
    expect(html).toContain('<strong>Timezone</strong>');
    expect(html).toContain('<strong>Next run</strong>');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });
});
