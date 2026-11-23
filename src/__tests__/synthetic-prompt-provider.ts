/**
 * SYNTHETIC upstream for prompt-refinement tests and the e2e server. It is NOT a model:
 * it never leaves the process, needs no key, and only echoes what it received so tests can
 * prove which model / loop option actually reached the wire. Every suggestion says so.
 */
export interface SyntheticCall { url: string; model: string; instructions: string; content: string; authorization: string | null }

export const SYNTHETIC_LABEL = '[합성 공급자 · SYNTHETIC — 실제 모델 응답 아님]';

function sourceOf(content: string): string {
  const head = '[원문 — 그대로 보존할 작업 요청]\n';
  if (!content.startsWith(head)) return content;
  const end = content.indexOf('\n\n[사용자 목표]\n');
  return content.slice(head.length, end < 0 ? undefined : end);
}

export function createSyntheticPromptUpstream(calls: SyntheticCall[] = []) {
  const upstream = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { model: string; instructions: string; input: { content: string }[] };
    const headers = new Headers(init.headers);
    const content = body.input[0]?.content ?? '';
    calls.push({ url, model: body.model, instructions: body.instructions, content, authorization: headers.get('authorization') });
    const source = sourceOf(content);
    const loop = body.instructions.includes('loop-v1');
    const firstSentence = source.split(/\n|(?<=[.!?])\s/)[0]?.slice(0, 300) || source.slice(0, 300);
    const sections = [
      { kind: 'extracted', title: '원문 첫 문장', body: firstSentence },
      { kind: 'suggestion', title: '합성 응답 메타', body: `${SYNTHETIC_LABEL} model=${body.model}; loop=${loop ? 'on' : 'off'}; skill=${loop ? 'clarify-v1+loop-v1' : 'clarify-v1'}` },
      ...(loop && content.includes('[사용자 목표]\n(미입력')
        ? [{ kind: 'question', title: '목표 확인', body: `${SYNTHETIC_LABEL} 목표가 입력되지 않았습니다. 최종 목표를 한 문장으로 알려 주세요.` }]
        : []),
    ];
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ sections }) }] }] });
  };
  return { upstream, calls };
}
