import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResolvedReference } from '../../../../src/core/mention-reference';
import type { MentionCandidate } from '../../../../src/core/mention-search';
import { MetaPopoverPortal, useAnchoredPopover } from '../Card/MetaDropdown';
import { useMentionReferences } from '../../hooks/useMentionReferences';
import { useMentionSearch } from '../../hooks/useMentionSearch';
import {
  buildMentionToken,
  findActiveMention,
  removeMentionToken,
  replaceActiveMention,
  type ActiveMention,
} from './mentionCaret';
import {
  MENTION_TABS,
  MentionPopover,
  buildMentionRows,
  type MentionTab,
} from './MentionPopover';
import { MentionChips } from './MentionChips';

/**
 * `@` 멘션이 붙은 textarea — 드롭인 교체용.
 *
 * New Task와 Feedback 두 곳이 **같은 컴포넌트 하나**를 쓴다. 분기는 없고 props
 * 세 개(`boundarySelector` · `projectDir` · `excludeSessionIds`)로 컨텍스트만
 * 주입한다. dispatch 경로는 이 컴포넌트 아래로 한 줄도 내려가지 않는다 —
 * 참조는 제출 직전 호출부가 `appendReferenceBlock`으로 본문에 붙이는 문자열일
 * 뿐이고, 그래서 훅·런타임 어댑터가 무변경으로 남는다.
 */

let instanceCounter = 0;

export interface MentionTextareaProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /** 팝오버가 넘지 말아야 할 경계 — 다이얼로그 안이면 `.kv2-dialog`. */
  boundarySelector?: string;
  /** 현재 프로젝트 — 후보 정렬 우선순위. */
  projectDir?: string;
  /** 자기 참조 제외 — 카드가 아니라 세션 단위로 건다. */
  excludeSessionIds?: string[];
  /**
   * 붙여넣기 훅 — `FeedbackPanel`/`CreateCardDialog`의 클립보드 스크린샷 첨부를
   * 그대로 살리기 위해 통과시킨다. 빠뜨리면 기존 기능이 죽는다.
   */
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * 해석된 참조. 호출부가 제출 직전 `appendReferenceBlock(body, refs)`에 넘긴다.
   * 참조를 여기서 한 번만 해석해 위로 올리는 이유는, 호출부가 같은 본문으로
   * 훅을 한 번 더 돌리면 요청이 두 배가 되기 때문이다.
   */
  onReferencesChange?: (references: ResolvedReference[]) => void;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}

const EMPTY_EXCLUDES: string[] = [];

export const MentionTextarea: React.FC<MentionTextareaProps> = ({
  id,
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
  className,
  boundarySelector,
  projectDir,
  excludeSessionIds = EMPTY_EXCLUDES,
  onPaste,
  textareaRef,
  onReferencesChange,
  ariaInvalid,
  ariaDescribedBy,
}) => {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle, updatePosition } =
    useAnchoredPopover<HTMLTextAreaElement>(0, { boundarySelector });

  const [active, setActive] = useState<ActiveMention | null>(null);
  const [tab, setTab] = useState<MentionTab>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * Esc로 닫은 멘션의 **시작 위치**. 캐럿은 여전히 `@…` 안에 있으므로, 이걸
   * 기억해 두지 않으면 다음 렌더에서 곧바로 다시 열린다.
   *
   * 검색어가 아니라 시작 위치로 기억한다. 처음에는 `start:query`로 걸었는데,
   * 그러면 Esc 직후 한 글자만 더 쳐도 키가 달라져 팝오버가 도로 열렸다 — 사용자
   * 입장에서 Esc는 "이 검색어는 그만"이 아니라 "이 `@`는 멘션으로 안 쓸래"이고,
   * `@`를 지우지 않는 한 계속 타이핑하는 게 정상 흐름이다. 다른 `@`로 옮기거나
   * 그 구간을 벗어나면 다시 열린다.
   */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const idSuffix = useRef<number>(0);
  if (idSuffix.current === 0) {
    instanceCounter += 1;
    idSuffix.current = instanceCounter;
  }
  const listId = `mention-list-${idSuffix.current}`;
  const optionId = (index: number) => `mention-option-${idSuffix.current}-${index}`;

  const wantOpen = !disabled && active !== null && active.start !== dismissedStart;

  // 한 방향으로만 민다. 팝오버가 스스로 닫히는 경우(바깥 클릭)에는 `wantOpen`이
  // 그대로라 이 효과가 다시 돌지 않고, 따라서 닫힌 상태가 유지된다.
  useEffect(() => {
    setOpen(wantOpen);
  }, [wantOpen, setOpen]);

  const isOpen = open && wantOpen;

  const search = useMentionSearch({
    enabled: isOpen,
    query: active?.query ?? '',
    projectDir,
    excludeSessionIds,
  });
  const rowsModel = buildMentionRows(search.data, tab);

  const { tokens, references, loading: referencesLoading } = useMentionReferences(value);

  // 콜백은 ref로 받는다 — 호출부가 인라인 화살표를 넘겨도(흔하다) 참조가 실제로
  // 바뀔 때만 통지가 나가고, 렌더마다 부모를 흔들지 않는다.
  const referencesListener = useRef(onReferencesChange);
  referencesListener.current = onReferencesChange;
  useEffect(() => {
    referencesListener.current?.(references);
  }, [references]);

  // 검색 결과가 바뀌면 선택을 맨 위로 돌리고, 목록 높이가 달라졌으니 위치도
  // 다시 잰다(아래 공간이 모자라면 캐럿 위로 뒤집히는 판정이 여기서 갱신된다).
  useEffect(() => {
    setActiveIndex(0);
  }, [search.data, tab]);

  useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, rowsModel.items.length, updatePosition]);

  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      // `useAnchoredPopover`가 앵커로 삼는 요소 = textarea. 팝오버는 이 요소의
      // 하단 좌측에 붙는다(캐럿 좌표 미러링은 v2).
      (triggerRef as React.RefObject<HTMLTextAreaElement | null>).current = node;
      if (textareaRef) {
        (textareaRef as React.RefObject<HTMLTextAreaElement | null>).current = node;
      }
    },
    [triggerRef, textareaRef],
  );

  /** 다음 렌더에서 복원할 캐럿 위치. 값이 부모 state라 DOM이 한 박자 늦는다. */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const element = localRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [value]);

  const syncActive = useCallback((element: HTMLTextAreaElement) => {
    const caret = element.selectionStart ?? element.value.length;
    // 선택 영역이 있으면(드래그) 멘션 입력 중이 아니다.
    if (element.selectionEnd !== caret) {
      setActive(null);
      setDismissedStart(null);
      return;
    }
    const next = findActiveMention(element.value, caret);
    setActive(next);
    // 멘션 구간을 완전히 벗어나면 Esc 기억을 푼다. 이게 없으면 `@foo`를 Esc로
    // 닫고 지운 뒤 **같은 위치에** 새 `@`를 쳤을 때 위치가 같다는 이유로 계속
    // 닫혀 있다.
    if (!next) setDismissedStart(null);
  }, []);

  const dismiss = useCallback(() => {
    setDismissedStart(active?.start ?? null);
    setOpen(false);
  }, [active, setOpen]);

  const applyEdit = useCallback(
    (edit: { next: string; caret: number }) => {
      pendingCaret.current = edit.caret;
      onChange(edit.next);
    },
    [onChange],
  );

  const select = useCallback(
    (candidate: MentionCandidate) => {
      if (!active || candidate.disabledReason === 'self') return;
      const token = buildMentionToken(candidate.kind, candidate.id);
      applyEdit(replaceActiveMention(value, active, token));
      setActive(null);
      setOpen(false);
    },
    [active, applyEdit, value, setOpen],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      const { candidates } = rowsModel;
      if (candidates.length === 0) return;
      setActiveIndex((current) => {
        // 자기 참조로 막힌 행은 건너뛴다 — 멈춰 설 수 있으면 Enter가 먹통이 된다.
        let next = current;
        for (let step = 0; step < candidates.length; step += 1) {
          next = (next + delta + candidates.length) % candidates.length;
          if (candidates[next]?.disabledReason !== 'self') return next;
        }
        return current;
      });
    },
    [rowsModel],
  );

  const cycleTab = useCallback((delta: number) => {
    setTab((current) => {
      const at = MENTION_TABS.findIndex((entry) => entry.id === current);
      const next = (at + delta + MENTION_TABS.length) % MENTION_TABS.length;
      return MENTION_TABS[next].id;
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'ArrowDown':
          // preventDefault가 없으면 캐럿이 같이 움직여 구간이 깨진다.
          e.preventDefault();
          moveSelection(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveSelection(-1);
          return;
        case 'Tab':
          // preventDefault가 없으면 포커스가 다음 필드로 날아간다.
          e.preventDefault();
          cycleTab(e.shiftKey ? -1 : 1);
          return;
        case 'Enter': {
          const candidate = rowsModel.candidates[activeIndex];
          // 고를 게 없으면 평소대로 개행한다. 이때 구간에 개행이 들어가므로
          // `findActiveMention`이 null을 돌려주고 팝오버는 저절로 닫힌다.
          if (!candidate || candidate.disabledReason === 'self') return;
          e.preventDefault();
          select(candidate);
          return;
        }
        case 'Escape':
          e.preventDefault();
          // stopPropagation이 없으면 `DialogSkeleton`의 onKeyDown이 Escape를
          // 받아 다이얼로그까지 닫는다. 팝오버가 열려 있는 동안 Esc는 여기서
          // 멈춘다.
          e.stopPropagation();
          dismiss();
          return;
        default:
      }
    },
    [isOpen, moveSelection, cycleTab, rowsModel, activeIndex, select, dismiss],
  );

  const handleRemove = useCallback(
    (raw: string) => {
      applyEdit(removeMentionToken(value, raw));
    },
    [applyEdit, value],
  );

  const activeOptionId = isOpen && rowsModel.candidates[activeIndex]
    ? optionId(activeIndex)
    : undefined;

  /**
   * 좌표만 가져오고 `minWidth`는 버린다. `useAnchoredPopover`는 트리거 폭을
   * 최소폭으로 실어 주는데, 여기서 트리거는 다이얼로그 폭을 꽉 채운 textarea라
   * 그대로 두면 팝오버가 800px까지 늘어난다. 폭은 `kv2-mention-pop`의 520px.
   */
  const popoverPosition: React.CSSProperties = {
    position: popoverStyle.position,
    top: popoverStyle.top,
    left: popoverStyle.left,
    visibility: popoverStyle.visibility,
    pointerEvents: popoverStyle.pointerEvents,
  };

  return (
    <div className="kv2-mention-host">
      <textarea
        id={id}
        ref={setRefs}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          syncActive(e.target);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => syncActive(e.currentTarget)}
        onClick={(e) => syncActive(e.currentTarget)}
        onPaste={onPaste}
        onBlur={() => setActive(null)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-invalid={ariaInvalid ? 'true' : 'false'}
        aria-describedby={ariaDescribedBy}
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={activeOptionId}
      />

      {isOpen && (
        <MetaPopoverPortal>
          <MentionPopover
            popoverRef={popoverRef}
            style={popoverPosition}
            query={active?.query ?? ''}
            tab={tab}
            onTabChange={setTab}
            data={search.data}
            rows={rowsModel}
            activeIndex={activeIndex}
            loading={search.loading}
            error={search.error}
            onHover={setActiveIndex}
            onSelect={select}
            listId={listId}
            optionId={optionId}
          />
        </MetaPopoverPortal>
      )}

      <MentionChips
        tokens={tokens}
        references={references}
        loading={referencesLoading}
        onRemove={handleRemove}
        disabled={disabled}
      />
    </div>
  );
};
