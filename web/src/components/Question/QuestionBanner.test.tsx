import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionRequest } from '../../hooks/useQuestionsApi';
import { QuestionBanner } from './QuestionBanner';
import {
  OTHER_ESCAPE_LAYER_SELECTOR,
  hasOtherEscapeLayer,
  questionRuntimeLabel,
  resolveQuestionEscape,
  type QuestionEscapeInput,
} from './questionBannerModel';

const request: QuestionRequest = {
  id: 'q-1',
  sessionID: 'ses_abcdef123456',
  questions: [
    {
      question: 'Which branch?',
      header: 'Branch',
      options: [{ label: 'main', description: 'default' }],
    },
  ],
};

const escape: QuestionEscapeInput = {
  key: 'Escape',
  defaultPrevented: false,
  minimized: false,
  isSubmitting: false,
  otherLayerOpen: false,
};

describe('resolveQuestionEscape', () => {
  test('Escape on an open banner minimizes it', () => {
    expect(resolveQuestionEscape(escape)).toBe('minimize');
  });

  test('yields to a popover/modal that is still open or already handled the key', () => {
    expect(resolveQuestionEscape({ ...escape, otherLayerOpen: true })).toBe('ignore');
    expect(resolveQuestionEscape({ ...escape, defaultPrevented: true })).toBe('ignore');
  });

  test('ignores other keys, an already-minimized banner, and a submit in flight', () => {
    expect(resolveQuestionEscape({ ...escape, key: 'Enter' })).toBe('ignore');
    expect(resolveQuestionEscape({ ...escape, minimized: true })).toBe('ignore');
    expect(resolveQuestionEscape({ ...escape, isSubmitting: true })).toBe('ignore');
  });

  test('no combination of inputs rejects the question', () => {
    const flags = [false, true];
    for (const key of ['Escape', 'Enter']) {
      for (const defaultPrevented of flags) {
        for (const minimized of flags) {
          for (const isSubmitting of flags) {
            for (const otherLayerOpen of flags) {
              const action = resolveQuestionEscape({ key, defaultPrevented, minimized, isSubmitting, otherLayerOpen });
              expect(['minimize', 'ignore']).toContain(action);
            }
          }
        }
      }
    }
  });
});

describe('hasOtherEscapeLayer', () => {
  const banner = { id: 'banner' };
  const inside = { id: 'option-inside-banner' };
  const filter = { id: 'filter-popover' };
  const bannerNode = { contains: (n: { id: string }) => n === banner || n === inside };
  const rootWith = (nodes: { id: string }[]) => ({
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(OTHER_ESCAPE_LAYER_SELECTOR);
      return nodes;
    },
  });

  test('the banner itself (and anything inside it) does not count', () => {
    expect(hasOtherEscapeLayer(rootWith([banner, inside]), bannerNode)).toBe(false);
  });

  test('an open filter popover outside the banner does', () => {
    expect(hasOtherEscapeLayer(rootWith([banner, filter]), bannerNode)).toBe(true);
  });

  test('Board columns (permanent listboxes) are not Escape layers', () => {
    expect(OTHER_ESCAPE_LAYER_SELECTOR).not.toContain('listbox');
  });
});

describe('questionRuntimeLabel', () => {
  test('labels the asking runtime from the catalog', () => {
    expect(questionRuntimeLabel('s1', [{ sessionId: 's1', agentRuntime: 'claude' }])).toBe('Claude');
    expect(questionRuntimeLabel('s1', [{ sessionId: 's1', agentRuntime: 'codex' }])).toBe('Codex');
  });

  test('adds the opencode preset agent name', () => {
    expect(questionRuntimeLabel('s1', [{ sessionId: 's1', agentRuntime: 'opencode', agentType: 'sisyphus' }]))
      .toBe('Opencode · Sisyphus');
  });

  test('a session with no card falls back to the default runtime', () => {
    expect(questionRuntimeLabel('missing', [])).toBe('Opencode');
  });
});

describe('QuestionBanner markup', () => {
  test('renders a labelled modal dialog titled by the runtime, without rejecting', () => {
    const onReject = mock(async () => {});
    const html = renderToStaticMarkup(
      <QuestionBanner
        questions={[request]}
        onReply={async () => {}}
        onReject={onReject}
        runtimeLabel={() => 'Claude'}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain('Claude needs your input');
    expect(html).not.toContain('opencode needs your input');
    expect(html).toContain('aria-label="Minimize question"');
    expect(html).toContain('>Reject</button>');
    expect(onReject).not.toHaveBeenCalled();
  });

  test('falls back to a generic title without a runtime resolver', () => {
    const html = renderToStaticMarkup(
      <QuestionBanner questions={[request]} onReply={async () => {}} onReject={async () => {}} />,
    );
    expect(html).toContain('Agent needs your input');
  });
});
