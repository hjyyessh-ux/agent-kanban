import { useEffect, useMemo, useState } from 'react';
import {
  parseMentionTokens,
  type MentionToken,
  type ResolvedReference,
} from '../../../src/core/mention-reference';
import { resolveMentions } from './useKanbanApi';

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
 */

const DEBOUNCE_MS = 300;

export interface UseMentionReferencesResult {
  /** 본문에서 파싱한 토큰. 칩은 해석 결과가 오기 전에도 이것으로 먼저 그린다. */
  tokens: MentionToken[];
  /** 해석된 참조. 순서는 `tokens`와 같다. */
  references: ResolvedReference[];
  loading: boolean;
}

export function useMentionReferences(text: string): UseMentionReferencesResult {
  const tokens = useMemo(() => parseMentionTokens(text), [text]);
  // 토큰 목록의 내용 지문. 산문만 고치는 동안에는 이 값이 그대로라 재요청이 없다.
  const tokenKey = tokens.map((token) => token.raw).join(' ');

  const [references, setReferences] = useState<ResolvedReference[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tokenKey) {
      setReferences([]);
      setLoading(false);
      return;
    }

    const raws = tokenKey.split(' ');
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      resolveMentions(raws, controller.signal)
        .then((resolved) => setReferences(resolved))
        .catch(() => {
          // 해석이 실패해도 토큰은 본문에 남아 있고 칩도 계속 보인다. 참조를
          // 잃는 게 아니라 라벨만 못 채운 상태로 두는 편이 낫다.
          if (controller.signal.aborted) return;
          setReferences([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tokenKey]);

  return { tokens, references, loading };
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
 */
export async function resolveReferencesForSubmit(
  text: string,
  cached: ResolvedReference[],
): Promise<ResolvedReference[]> {
  const raws = parseMentionTokens(text).map((token) => token.raw);
  if (raws.length === 0) return [];

  const cachedRaws = cached.map((reference) => reference.raw);
  const isFresh = cachedRaws.length === raws.length
    && raws.every((raw, index) => cachedRaws[index] === raw);
  if (isFresh) return cached;

  try {
    return await resolveMentions(raws);
  } catch {
    return cached;
  }
}
