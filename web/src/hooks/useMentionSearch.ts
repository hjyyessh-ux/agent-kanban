import { useEffect, useRef, useState } from 'react';
import type { MentionSearchResponse } from '../../../src/core/mention-search';
import { fetchMentions } from './useKanbanApi';

/**
 * `@` 멘션 후보 검색 — `GET /api/mentions`, 150ms 디바운스 + `AbortController`.
 *
 * 폴링이 아니다. 이 프로젝트의 다른 훅과 달리 주기가 없고, **팝오버가 열려 있는
 * 동안 검색어가 바뀔 때만** 돈다(`enabled`). 요청 하나가 보드 파싱 6~11ms +
 * vault glob 5ms 수준이라 서버측 캐시 계층 없이도 견디는 전제이며, 그 전제를
 * 지키는 게 이 디바운스와 중단 처리다.
 */

/** 탭별 노출 개수. All 탭은 이 중 앞부분만 섞어 보여준다. */
export const MENTION_PAGE_SIZE = 8;

const DEBOUNCE_MS = 150;

export interface UseMentionSearchInput {
  /** 팝오버가 열려 있는가. 닫혀 있으면 요청하지 않는다. */
  enabled: boolean;
  /** `@` 뒤 검색어. 빈 문자열이면 종류별 최근 항목이 온다. */
  query: string;
  /** 현재 카드의 프로젝트 — 같은 디렉토리 항목이 먼저 정렬된다. */
  projectDir?: string;
  /** 자기 참조로 막을 세션들. 후보에는 남고 선택만 불가로 표시된다. */
  excludeSessionIds?: string[];
}

export interface UseMentionSearchResult {
  data: MentionSearchResponse | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_EXCLUDES: string[] = [];

export function useMentionSearch({
  enabled,
  query,
  projectDir,
  excludeSessionIds = EMPTY_EXCLUDES,
}: UseMentionSearchInput): UseMentionSearchResult {
  const [data, setData] = useState<MentionSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 배열 prop은 호출부에서 매번 새로 만들어지기 쉬우므로, 효과의 의존성은
  // 내용으로 고정한다. 이게 없으면 부모가 리렌더될 때마다 재요청이 나간다.
  const excludeKey = excludeSessionIds.join(',');

  // 팝오버를 닫았다 열면 이전 결과가 잠깐 보이지 않게 비운다.
  const wasEnabled = useRef(enabled);
  if (wasEnabled.current !== enabled) {
    wasEnabled.current = enabled;
    if (!enabled && data !== null) setData(null);
  }

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetchMentions(
        {
          q: query,
          limit: MENTION_PAGE_SIZE,
          projectDir,
          excludeSessionIds: excludeKey ? excludeKey.split(',') : undefined,
        },
        controller.signal,
      )
        .then((response) => {
          setData(response);
          setError(null);
        })
        .catch((e: unknown) => {
          // 중단은 실패가 아니다 — 다음 키 입력이 이미 새 요청을 띄웠다.
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : 'Failed to search mentions');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, query, projectDir, excludeKey]);

  return { data, loading, error };
}
