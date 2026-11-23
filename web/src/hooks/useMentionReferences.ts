import { useEffect, useMemo, useState } from 'react';
import {
  parseMentionTokens,
  type MentionToken,
  type ResolvedReference,
  type SkillLaunchStatus,
} from '../../../src/core/mention-reference';
import { parseSkillLaunch } from '../../../src/core/mention-skills';
import type { AgentRuntime } from '../../../src/core/types';
import { fetchMentionResolve, resolveMentions } from './useKanbanApi';

/**
 * 본문 → 토큰 → 해석된 참조.
 *
 * **본문 텍스트가 단일 진실**이라는 설계가 여기에 걸려 있다. 선택된 참조를 담는
 * state는 없고, 매번 본문을 다시 파싱해 토큰을 얻는다. 사용자가 본문에서
 * `@session:kx9f2a1b`를 지우면 그 참조는 다음 렌더에 그냥 사라진다 — 지울
 * state가 없으므로 desync가 날 자리가 없다.
 *
 * 해석은 토큰 목록이 **실제로 바뀌었을 때만** 다시 한다. 본문은 타이핑 내내
 * 바뀌지만 토큰은 선택/삭제 순간에만 바뀌므로, 앞뒤 산문을 고치는 동안 네트워크가
 * 조용하다.
 *
 * 스킬은 카드의 runtime × projectDir에 따라 해석 결과가 달라지므로 그 둘도 키에
 * 들어간다. 첫 줄 실행 라인(`/name`)은 토큰이 아니라서 따로 검증한다(`launch`).
 */

const DEBOUNCE_MS = 300;

export interface MentionReferenceContext {
  runtime?: AgentRuntime;
  projectDir?: string;
  /** 첫 줄 `/name` 실행 라인을 검증할지. 첫 줄이 보장되는 입력창에서만 켠다. */
  checkLaunch?: boolean;
}

export interface UseMentionReferencesResult {
  /** 본문에서 파싱한 토큰. 칩은 해석 결과가 오기 전에도 이것으로 먼저 그린다. */
  tokens: MentionToken[];
  /** 해석된 참조. 순서는 `tokens`와 같다. */
  references: ResolvedReference[];
  /** 첫 줄 실행 라인의 이름(검증 전에도 즉시). */
  launchName: string | null;
  /** 첫 줄 실행 라인 검증 결과. 해석이 끝나기 전에는 `null`. */
  launch: SkillLaunchStatus | null;
  loading: boolean;
}

const EMPTY_CONTEXT: MentionReferenceContext = {};

export function useMentionReferences(
  text: string,
  context: MentionReferenceContext = EMPTY_CONTEXT,
): UseMentionReferencesResult {
  const tokens = useMemo(() => parseMentionTokens(text), [text]);
  const launchName = useMemo(
    () => (context.checkLaunch ? parseSkillLaunch(text)?.name ?? null : null),
    [text, context.checkLaunch],
  );
  // 토큰 목록의 내용 지문. 산문만 고치는 동안에는 이 값이 그대로라 재요청이 없다.
  const tokenKey = tokens.map((token) => token.raw).join(' ');
  const { runtime, projectDir } = context;

  const [references, setReferences] = useState<ResolvedReference[]>([]);
  const [launch, setLaunch] = useState<SkillLaunchStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tokenKey && !launchName) {
      setReferences([]);
      setLaunch(null);
      setLoading(false);
      return;
    }

    const raws = tokenKey ? tokenKey.split(' ') : [];
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetchMentionResolve(
        raws,
        { runtime, projectDir, ...(launchName ? { launch: launchName } : {}) },
        controller.signal,
      )
        .then((resolved) => {
          setReferences(resolved.references);
          setLaunch(resolved.launch ?? null);
        })
        .catch(() => {
          // 해석이 실패해도 토큰은 본문에 남아 있고 칩도 계속 보인다. 참조를
          // 잃는 게 아니라 라벨만 못 채운 상태로 두는 편이 낫다.
          if (controller.signal.aborted) return;
          setReferences([]);
          setLaunch(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tokenKey, launchName, runtime, projectDir]);

  return { tokens, references, launchName, launch, loading };
}

/**
 * 제출 직전 해석 — 디바운스를 기다리지 않는다.
 *
 * `useMentionReferences`의 300ms 디바운스와 왕복은 **사람이 이긴다**: 참조를 고른
 * 직후 CREATE를 누르면 칩은 떠 있는데(칩은 본문 토큰에서 바로 그려진다) 저장된
 * `description`에는 블록이 없는 상태가 된다. 참조가 조용히 사라지는 이 실패가
 * 이 기능에서 가장 나쁜 실패이므로, 제출 경로는 상태 스냅샷이 아니라 **본문을
 * 다시 읽어** 해석한다.
 *
 * 이미 해석해 둔 것이 지금 본문의 토큰과 정확히 같으면 요청하지 않는다. 해석에
 * 실패하면 가진 것으로 진행한다 — 참조 때문에 제출 자체가 막히면 안 된다.
 *
 * 스킬 토큰이 섞여 있으면 캐시를 믿지 않는다 — 제출 직전에 runtime·projectDir을
 * 바꿨을 수 있고, 그 경우 같은 토큰이라도 해석이 달라진다.
 */
export async function resolveReferencesForSubmit(
  text: string,
  cached: ResolvedReference[],
  context: MentionReferenceContext = EMPTY_CONTEXT,
): Promise<ResolvedReference[]> {
  const tokens = parseMentionTokens(text);
  const raws = tokens.map((token) => token.raw);
  if (raws.length === 0) return [];

  const cachedRaws = cached.map((reference) => reference.raw);
  const hasSkill = tokens.some((token) => token.kind === 'skill');
  const isFresh = !hasSkill
    && cachedRaws.length === raws.length
    && raws.every((raw, index) => cachedRaws[index] === raw);
  if (isFresh) return cached;

  try {
    return await resolveMentions(raws, undefined, { runtime: context.runtime, projectDir: context.projectDir });
  } catch {
    return cached;
  }
}

/**
 * 제출 직전 첫 줄 실행 라인 검증. 라인이 없으면 `null`(검증할 것 없음).
 * 네트워크 실패는 막지 않는다(`null`) — 검증 서버가 죽었다고 카드 생성이 막히면
 * 안 된다. 명시적 `ok: false`만 제출을 막는 근거다.
 */
export async function checkLaunchForSubmit(
  text: string,
  context: MentionReferenceContext,
): Promise<SkillLaunchStatus | null> {
  const launchName = parseSkillLaunch(text)?.name;
  if (!launchName) return null;
  try {
    const resolved = await fetchMentionResolve([], { runtime: context.runtime, projectDir: context.projectDir, launch: launchName });
    return resolved.launch ?? null;
  } catch {
    return null;
  }
}
