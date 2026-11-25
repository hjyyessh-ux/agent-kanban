import { CLAUDE_MODELS, CODEX_MODELS } from '../core/runtime-config';
import {
  findCatalogModel, PROMPT_CARD_MODEL_PATTERN, type PromptCatalogModel, type PromptCatalogProvider, type PromptModelRef,
  type PromptProviderName, type PromptReadinessCheck, type PromptRefinementCatalog,
} from '../core/prompt-proposal';

/** Server-side state of one refinement transport. `configured=false` lists the
 * provider (and its card-catalog models) as unavailable with `issue` as the reason. */
export interface PromptTransportStatus {
  provider: Extract<PromptProviderName, 'OpenAI' | 'Codex CLI' | 'Claude CLI'>;
  configured: boolean;
  issue?: string;
  defaultModel?: string;
  /** Server allow-list (refinement only). */
  models: string[];
  checks: PromptReadinessCheck[];
}

const DOC = 'docs/prompt-refinement-provider.md';
const INFO: Record<PromptProviderName, { billing: string; settingsHint: string; allowList?: string }> = {
  'Codex CLI': {
    billing: '전용 Codex 로그인 계정의 구독 한도 적용 · 원문은 OpenAI로 전송',
    settingsHint: `서버 환경 변수 KANBAN_PROMPT_CODEX_ENABLED · _BINARY · _BINARY_SHA256 · _MODEL · _MODELS (변경 후 서버 재시작) · ${DOC}`,
    allowList: 'KANBAN_PROMPT_CODEX_MODELS',
  },
  OpenAI: {
    billing: '전용 OpenAI API 프로젝트 사용료 적용',
    settingsHint: `서버 환경 변수 KANBAN_PROMPT_AI_ENABLED · KANBAN_PROMPT_OPENAI_API_KEY · _MODEL · _MODELS (변경 후 서버 재시작) · ${DOC}`,
    allowList: 'KANBAN_PROMPT_OPENAI_MODELS',
  },
  OpenCode: { billing: '—', settingsHint: `${DOC} · OpenCode는 카드 실행 전용` },
  'Claude CLI': {
    billing: '평소 Claude 로그인 계정의 구독 한도 적용 · 원문은 Anthropic으로 전송',
    settingsHint: `터미널에서 claude 로그인 (설치된 claude -p 사용) · 끄기: KANBAN_PROMPT_CLAUDE_ENABLED=false · 모델 제한: KANBAN_PROMPT_CLAUDE_MODELS · ${DOC}`,
    allowList: 'KANBAN_PROMPT_CLAUDE_MODELS',
  },
};
export type PromptCardModels = Partial<Record<Exclude<PromptProviderName, 'OpenAI'>, readonly { id: string; label: string }[]>>;
const cleanModels = (models: readonly { id: string; label: string }[]) =>
  models.filter(m => PROMPT_CARD_MODEL_PATTERN.test(m.id)).slice(0, 56);


function transportProvider(status: PromptTransportStatus, cardModels: readonly { id: string; label: string }[]): PromptCatalogProvider {
  const info = INFO[status.provider];
  const failing = status.checks.find(c => !c.ok);
  const ready = status.configured && !failing && status.models.length > 0;
  // Card catalog entries are listed so the user sees every known model, but only
  // the refinement allow-list can ever be selectable.
  const labels = new Map(cardModels.map(m => [m.id, m.label]));
  const cardIds = cardModels.map(m => m.id);
  const ids = [...new Set([...(status.configured ? status.models : []), ...cardIds])];
  const models: PromptCatalogModel[] = ids.map(id => {
    const allowed = status.configured && status.models.includes(id);
    const base = { id, label: labels.get(id) ?? id, serverDefault: ready && id === status.defaultModel };
    if (ready && allowed) return { ...base, selectable: true };
    const reason = !status.configured ? `${status.provider} 다듬기 경로 미설정 — ${status.issue ?? '서버 설정 없음'}`
      : failing ? `${failing.label} 확인 실패 — ${failing.detail}`
      : `다듬기 허용 목록에 없음 (카드 실행 카탈로그에만 있음)`;
    const settingsHint = status.configured && !failing && !allowed && info.allowList
      ? `서버 환경 변수 ${info.allowList}에 추가 후 서버 재시작` : info.settingsHint;
    return { ...base, selectable: false, reason, settingsHint };
  });
  const checks: PromptReadinessCheck[] = status.configured ? status.checks
    : [{ key: 'transport', label: '서버 연결 설정', ok: false, detail: status.issue ?? '서버 설정 없음' }];
  return {
    provider: status.provider, ready, billing: info.billing, settingsHint: info.settingsHint, checks, models,
    summary: ready ? `사용 가능 · 허용 모델 ${status.models.length}개`
      : !status.configured ? `사용 불가 · ${status.issue ?? '서버 설정 없음'}`
      : failing ? `사용 불가 · ${failing.label} 확인 실패` : '사용 불가 · 허용 모델 없음',
  };
}

function cardOnlyProvider(name: 'OpenCode', source: readonly { id: string; label: string }[]): PromptCatalogProvider {
  const info = INFO[name];
  const reason = `${name} 다듬기 전용 격리 경로 없음 (카드 실행 로그인을 재사용하지 않음)`;
  return {
    provider: name, ready: false, billing: info.billing, settingsHint: info.settingsHint,
    summary: '사용 불가 · 다듬기 어댑터 없음',
    checks: [{ key: 'transport', label: '다듬기 어댑터', ok: false, detail: '없음 — 카드 실행 런타임과 분리된 전용 경로 미구현' }],
    models: [...new Map(source.map(m => [m.id,m])).values()].map(m => ({ id: m.id, label: m.label, selectable: false, serverDefault: false, reason, settingsHint: info.settingsHint })),
  };
}

/** Pure: same inputs → same catalog. Order is fixed (Codex CLI, OpenAI, Claude CLI). */
export function buildPromptCatalog(transports: PromptTransportStatus[], saved: PromptModelRef | null, cardModels: PromptCardModels = {}): PromptRefinementCatalog {
  const byName = new Map(transports.map(t => [t.provider, t]));
  const cardList = { 'Codex CLI': cleanModels(cardModels['Codex CLI'] ?? CODEX_MODELS), OpenAI: [],
    'Claude CLI': cleanModels(cardModels['Claude CLI'] ?? CLAUDE_MODELS) };
  const providers = (['Codex CLI', 'OpenAI', 'Claude CLI'] as const).map(name =>
    transportProvider(byName.get(name) ?? { provider: name, configured: false, models: [], checks: [] }, cardList[name]));
  if (cardModels.OpenCode?.length) providers.push(cardOnlyProvider('OpenCode', cleanModels(cardModels.OpenCode)));
  const firstReady = providers.find(p => p.ready);
  const defaultModel = firstReady?.models.find(m => m.serverDefault) ?? firstReady?.models.find(m => m.selectable);
  const catalog: PromptRefinementCatalog = {
    providers,
    serverDefault: firstReady && defaultModel ? { provider: firstReady.provider, model: defaultModel.id } : null,
    savedDefault: null,
    effectiveDefault: null,
  };
  if (saved) {
    const entry = findCatalogModel(catalog, saved);
    catalog.savedDefault = entry?.selectable ? { ...saved, valid: true }
      : { ...saved, valid: false, reason: entry?.reason ?? '현재 카탈로그에 없는 모델' };
  }
  catalog.effectiveDefault = catalog.savedDefault?.valid
    ? { provider: catalog.savedDefault.provider, model: catalog.savedDefault.model } : catalog.serverDefault;
  return catalog;
}
