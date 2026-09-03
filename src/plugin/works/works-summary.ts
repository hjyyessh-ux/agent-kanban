import type { CodexReasoningEffort, Work, WorkSessionLink, WorkSummary } from '../../core/types';
import type { WikiLlmRunner } from '../wiki/wiki-llm';

/**
 * One connected session's transcript for summarization. `transcript` is
 * undefined when the session's transcript could not be loaded (old/cleaned-up
 * session, or a non-claude runtime) — those sessions are skipped and reported.
 */
export interface WorkTranscriptSource {
  link: WorkSessionLink;
  transcript?: string;
  title?: string;
}

export interface GenerateWorkSummaryResult {
  summary: WorkSummary;
  generatedSessions: string[];
  skippedSessions: { sessionId: string; reason: string }[];
}

/** Strip a leading bullet/number marker so LLM list formatting doesn't leak in. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
}

/**
 * Parse the LLM response into at most `lines` clean summary lines. Blank lines
 * and obvious preamble ("요약:", "다음은…") are dropped; each surviving line is a
 * single point.
 */
export function parseSummaryLines(raw: string, lines: number): string[] {
  return raw
    .split('\n')
    .map(stripMarker)
    .filter(Boolean)
    .filter(line => !/^(요약|summary)\s*[:：]?\s*$/i.test(line))
    .slice(0, lines);
}

export function buildWorkSummaryPrompt(
  work: Work,
  sections: { title: string; transcript: string }[],
  lines: number,
): string {
  const body = sections
    .map((s, i) => `## 세션 ${i + 1}: ${s.title}\n${s.transcript}`)
    .join('\n\n');

  return [
    '당신은 여러 AI 코딩 세션을 하나로 묶은 "Work"의 요약을 작성합니다.',
    `아래 세션 대화 기록 전체를 종합해, 한국어로 정확히 ${lines}줄의 요약을 작성하세요.`,
    '',
    '규칙:',
    '- 각 줄은 한 가지 핵심만 담습니다.',
    "- '무엇을 했나 → 어떤 결정을 내렸나 → 남은 일' 순서를 우선합니다.",
    '- 불릿 기호나 번호를 붙이지 말고, 한 줄에 하나씩 작성합니다.',
    '- 추측하지 말고 대화에 근거해 사실만 적습니다.',
    `- 정확히 ${lines}줄만 출력하고, 그 외 설명·머리말은 붙이지 않습니다.`,
    '',
    `# Work 제목\n${work.title}`,
    '',
    `# 세션 기록\n${body}`,
  ].join('\n');
}

/**
 * Generate a Work Summary by feeding every connected session's transcript to the
 * shared wiki LLM runner. Sessions without a transcript are skipped and returned
 * in `skippedSessions`. Throws when no session has a usable transcript, or when
 * the model returns an empty summary.
 */
export async function generateWorkSummary(deps: {
  work: Work;
  sources: WorkTranscriptSource[];
  lines: number;
  model: string;
  effort: CodexReasoningEffort;
  llmRunner: WikiLlmRunner;
}): Promise<GenerateWorkSummaryResult> {
  const usable = deps.sources.filter(s => s.transcript && s.transcript.trim());
  const skippedSessions = deps.sources
    .filter(s => !s.transcript || !s.transcript.trim())
    .map(s => ({ sessionId: s.link.sessionId, reason: 'transcript unavailable' }));

  if (usable.length === 0) {
    throw new Error('No session transcripts available to summarize');
  }

  const sections = usable.map(s => ({
    title: s.title?.trim() || s.link.sessionId,
    transcript: s.transcript as string,
  }));
  const prompt = buildWorkSummaryPrompt(deps.work, sections, deps.lines);
  const raw = await deps.llmRunner(prompt, { model: deps.model, effort: deps.effort });
  const parsedLines = parseSummaryLines(raw, deps.lines);
  if (parsedLines.length === 0) {
    throw new Error('LLM returned an empty summary');
  }

  return {
    summary: {
      lines: parsedLines,
      generatedAt: new Date().toISOString(),
      model: deps.model,
    },
    generatedSessions: usable.map(s => s.link.sessionId),
    skippedSessions,
  };
}
