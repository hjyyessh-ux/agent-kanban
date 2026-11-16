import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCard } from '../../../../src/core/types';
import {
  BoardSessionGroupCard,
  groupCompleteCardsBySession,
  useSessionGroupDisclosure,
  type CompleteSessionGroup,
} from './BoardCompleteSessionView';

function turn(id: string, hour: number, overrides: Partial<KanbanCard> = {}): KanbanCard {
  const at = `2026-11-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return {
    id,
    title: `Turn ${id}`,
    description: `Prompt ${id}`,
    status: 'complete',
    sessionId: 'sess-origin',
    agentRuntime: 'claude',
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    completedSeenAt: at,
    ...overrides,
  };
}

const Harness: React.FC<{ group: CompleteSessionGroup }> = ({ group }) => {
  const disclosure = useSessionGroupDisclosure({ groups: [group] });
  return (
    <BoardSessionGroupCard group={group} status="complete" disclosure={disclosure} onCardClick={mock(() => undefined)} />
  );
};

function render(cards: KanbanCard[]) {
  const [group] = groupCompleteCardsBySession(cards);
  return renderToStaticMarkup(<Harness group={group} />);
}

/** Splits the markup into the group header and each turn article (keyed by card id). */
function sections(html: string) {
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  const turns = new Map<string, string>();
  for (const match of html.matchAll(/<article data-card-id="([^"]+)"[\s\S]*?<\/article>/g)) {
    turns.set(match[1], match[0]);
  }
  return { header, turns };
}

describe('BoardSessionGroupCard — turn request origin', () => {
  const cards = [
    turn('dots', 3, { requestedBy: 'dots' }),
    turn('tg', 2, { originChannel: 'telegram' }),
    turn('plain', 1, { requestedBy: 'user' }),
  ];

  test('Dots on dots turns, Telegram on telegram turns, nothing on direct turns', () => {
    const { turns } = sections(render(cards));
    expect(turns.size).toBe(3);
    expect(turns.get('dots')).toContain('aria-label="Dots"');
    expect(turns.get('dots')).not.toContain('aria-label="Telegram"');
    expect(turns.get('tg')).toContain('aria-label="Telegram"');
    expect(turns.get('tg')).not.toContain('aria-label="Dots"');
    expect(turns.get('plain')).not.toContain('kv2-dots-badge');
    expect(turns.get('plain')).not.toContain('kv2-telegram-badge');
  });

  test('the SESSION group header never carries an origin badge', () => {
    const { header } = sections(render(cards));
    expect(header).toContain('kv2-complete-session-header');
    expect(header).not.toContain('kv2-dots-badge');
    expect(header).not.toContain('kv2-telegram-badge');
  });

  test('runtime chip stays separate from the origin badge', () => {
    const html = render(cards);
    expect(html).toContain('CLAUDE');
    expect(html.match(/kv2-dots-badge/g)).toHaveLength(1);
    expect(html.match(/kv2-telegram-badge/g)).toHaveLength(1);
  });
});
