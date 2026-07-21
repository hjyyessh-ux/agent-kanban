import type { AgentRuntime, ClaudePermissionMode, CodexSandboxMode, KanbanCard } from '../core/types';
import { getDefaultModelForAgent, getPrimaryAgentDisplayLabel } from '../core/agent-config';
import { normalizeAgentType } from '../core/agent-type';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  isClaudeModelValid,
  isCodexModelValid,
} from '../core/runtime-config';

export interface TelegramSessionSummary {
  index: number;
  sessionId: string;
  cardId: string;
  title: string;
  status: KanbanCard['status'];
  agentRuntime: AgentRuntime;
  agentType?: string;
  model?: string;
  projectDir?: string;
  updatedAt: string;
}

export interface TelegramCommandContext {
  chatId: number;
  sessions: TelegramSessionSummary[];
  selectedSessionId?: string;
  selectedCardId?: string;
  defaultAgentRuntime?: AgentRuntime;
  defaultAgentType?: string;
  defaultModel?: string;
  defaultProjectDir?: string;
  defaultClaudePermissionMode?: ClaudePermissionMode;
  defaultClaudeDangerouslySkipPermissions?: boolean;
  defaultCodexSandbox?: CodexSandboxMode;
}

export interface TelegramCommandDispatchPlan {
  type: 'dispatch';
  text: string;
  forceNewSession?: boolean;
  agentRuntime?: AgentRuntime;
  agentType?: string;
  model?: string;
  projectDir?: string;
  claudePermissionMode?: ClaudePermissionMode;
  claudeDangerouslySkipPermissions?: boolean;
  codexSandbox?: CodexSandboxMode;
  selectedSessionId?: string;
  selectedCardId?: string;
}

export type TelegramCommandResult =
  | { type: 'reply'; text: string }
  | { type: 'select-session'; text: string; sessionId: string; cardId: string; agentRuntime: AgentRuntime }
  | {
      type: 'set-defaults';
      text: string;
      agentRuntime?: AgentRuntime;
      agentType?: string | null;
      model?: string | null;
      projectDir?: string | null;
      claudePermissionMode?: ClaudePermissionMode | null;
      claudeDangerouslySkipPermissions?: boolean | null;
      codexSandbox?: CodexSandboxMode | null;
    }
  | TelegramCommandDispatchPlan;

interface TelegramCommandDefinition {
  token: `/${string}`;
  command: string;
  description: string;
  helpEntry: string;
  aliases?: string[];
  agentType?: string;
}

const RUNTIME_VALUES: AgentRuntime[] = ['opencode', 'codex', 'claude'];
const CLAUDE_PERMISSION_VALUES: ClaudePermissionMode[] = ['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'];
const CODEX_SANDBOX_VALUES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

const TELEGRAM_COMMAND_DEFINITIONS: readonly TelegramCommandDefinition[] = [
  {
    token: '/help',
    command: 'help',
    description: '사용 가능한 명령 보기',
    helpEntry: '/help',
  },
  {
    token: '/sessions',
    command: 'sessions',
    description: '세션 목록 보기',
    helpEntry: '/sessions (/세션목록)',
    aliases: ['/세션목록', '/session_list'],
  },
  {
    token: '/session_info',
    command: 'session_info',
    description: '현재 세션 정보 보기',
    helpEntry: '/session_info (/세션정보)',
    aliases: ['/세션정보', '/session'],
  },
  {
    token: '/switch_session',
    command: 'switch_session',
    description: '지정한 세션으로 전환',
    helpEntry: '/switch_session 3 (/세션변경 3)',
    aliases: ['/세션변경'],
  },
  {
    token: '/new_session',
    command: 'new_session',
    description: '다음 메시지부터 새 세션 시작',
    helpEntry: '/new_session (/새세션)',
    aliases: ['/새세션', '/new'],
  },
  {
    token: '/runtime',
    command: 'runtime',
    description: '기본 런타임 선택',
    helpEntry: '/runtime codex|claude|opencode',
  },
  {
    token: '/codex',
    command: 'codex',
    description: 'Codex로 새 작업 시작',
    helpEntry: '/codex 작업 내용',
  },
  {
    token: '/claude',
    command: 'claude',
    description: 'Claude로 새 작업 시작',
    helpEntry: '/claude 작업 내용',
  },
  {
    token: '/opencode',
    command: 'opencode',
    description: 'Opencode로 새 작업 시작',
    helpEntry: '/opencode [/헤파이스토] 작업 내용',
  },
  {
    token: '/codex_model',
    command: 'codex_model',
    description: 'Codex 기본 모델 설정',
    helpEntry: '/codex_model gpt-5.3-codex',
    aliases: ['/codex-model'],
  },
  {
    token: '/codex_model_list',
    command: 'codex_model_list',
    description: 'Codex 모델 목록 보기',
    helpEntry: '/codex_model_list',
    aliases: ['/codex-model-list'],
  },
  {
    token: '/claude_model',
    command: 'claude_model',
    description: 'Claude 기본 모델 설정',
    helpEntry: '/claude_model claude-sonnet-4-6',
    aliases: ['/claude-model'],
  },
  {
    token: '/claude_model_list',
    command: 'claude_model_list',
    description: 'Claude 모델 목록 보기',
    helpEntry: '/claude_model_list',
    aliases: ['/claude-model-list'],
  },
  {
    token: '/directory',
    command: 'directory',
    description: '기본 작업 디렉토리 설정',
    helpEntry: '/directory /path/to/project 또는 /directory clear',
  },
  {
    token: '/claude_permission',
    command: 'claude_permission',
    description: 'Claude 권한 모드 설정',
    helpEntry: '/claude_permission acceptEdits|bypassPermissions|plan|dontAsk',
  },
  {
    token: '/claude_skip_permissions',
    command: 'claude_skip_permissions',
    description: 'Claude 권한 스킵 설정',
    helpEntry: '/claude_skip_permissions on|off',
  },
  {
    token: '/codex_sandbox',
    command: 'codex_sandbox',
    description: 'Codex sandbox 설정',
    helpEntry: '/codex_sandbox read-only|workspace-write|danger-full-access',
  },
  {
    token: '/agent_sisyphus',
    command: 'agent_sisyphus',
    description: '기본 에이전트를 Sisyphus로 설정',
    helpEntry: '/agent_sisyphus (/시시푸스)',
    aliases: ['/시시푸스'],
    agentType: 'sisyphus',
  },
  {
    token: '/agent_hephaestus',
    command: 'agent_hephaestus',
    description: '기본 에이전트를 Hephaestus로 설정',
    helpEntry: '/agent_hephaestus (/헤파이스토)',
    aliases: ['/헤파이스토', '/헤파이토스'],
    agentType: 'hephaestus',
  },
  {
    token: '/agent_prometheus',
    command: 'agent_prometheus',
    description: '기본 에이전트를 Prometheus로 설정',
    helpEntry: '/agent_prometheus (/프로메테우스)',
    aliases: ['/프로메테우스'],
    agentType: 'prometheus',
  },
  {
    token: '/agent_atlas',
    command: 'agent_atlas',
    description: '기본 에이전트를 Atlas로 설정',
    helpEntry: '/agent_atlas (/아틀라스)',
    aliases: ['/아틀라스'],
    agentType: 'atlas',
  },
];

const COMMAND_ALIASES: Record<string, string> = Object.fromEntries(
  TELEGRAM_COMMAND_DEFINITIONS.flatMap(definition =>
    (definition.aliases ?? []).map(alias => [alias, definition.token] as const),
  ),
);

const AGENT_COMMANDS: Record<string, string> = Object.fromEntries(
  TELEGRAM_COMMAND_DEFINITIONS.flatMap(definition =>
    definition.agentType ? [[definition.token, definition.agentType] as const] : [],
  ),
);

export function getTelegramRegisteredCommands(): Array<{ command: string; description: string }> {
  return TELEGRAM_COMMAND_DEFINITIONS.map(({ command, description }) => ({ command, description }));
}

export function buildTelegramHelpText(): string {
  return [
    '🤖 사용 가능한 명령',
    '',
    '기본',
    '- /help: 사용 가능한 명령 보기',
    '- /sessions (/세션목록): 세션 목록 보기',
    '- /session_info (/세션정보): 현재 세션 정보 보기',
    '- /switch_session 3 (/세션변경 3): 지정한 세션으로 전환',
    '- /new_session (/새세션): 다음 메시지부터 새 세션 시작',
    '',
    '런타임',
    '- /runtime: 현재 기본 실행 설정 보기',
    '- /runtime codex|claude|opencode: 기본 런타임 변경',
    '- /codex 작업 내용: Codex로 새 작업 시작',
    '- /claude 작업 내용: Claude로 새 작업 시작',
    '- /opencode [/헤파이스토] 작업 내용: Opencode로 새 작업 시작',
    '',
    '모델',
    '- /codex_model_list: Codex 모델 id 목록 보기',
    '- /codex_model gpt-5.3-codex: Codex 기본 모델 설정',
    '- /claude_model_list: Claude 모델 id 목록 보기',
    '- /claude_model claude-sonnet-4-6: Claude 기본 모델 설정',
    '',
    '디렉토리',
    '- /directory: 현재 기본 디렉토리 보기',
    '- /directory /path/to/project: 기본 디렉토리 설정',
    '- /directory clear: 기본 디렉토리 해제',
    '',
    '권한',
    '- /claude_permission acceptEdits|bypassPermissions|plan|dontAsk: Claude 권한 모드 설정',
    '- /claude_skip_permissions on|off: Claude 권한 스킵 설정',
    '- /codex_sandbox read-only|workspace-write|danger-full-access: Codex sandbox 설정',
    '',
    'Opencode 에이전트',
    '- /agent_sisyphus (/시시푸스): 기본 에이전트를 Sisyphus로 설정',
    '- /agent_hephaestus (/헤파이스토): 기본 에이전트를 Hephaestus로 설정',
    '- /agent_prometheus (/프로메테우스): 기본 에이전트를 Prometheus로 설정',
    '- /agent_atlas (/아틀라스): 기본 에이전트를 Atlas로 설정',
    '- 일반 메시지 끝에 /헤파이스토 같은 에이전트 명령을 붙이면 Opencode 새 작업으로 실행합니다.',
  ].join('\n');
}

function stripTelegramCommandMention(token: string): string {
  if (!token.startsWith('/')) {
    return token;
  }

  const mentionIndex = token.indexOf('@');
  return mentionIndex === -1 ? token : token.slice(0, mentionIndex);
}

function formatRuntime(runtime: AgentRuntime | undefined): string {
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'claude') return 'Claude';
  return 'Opencode';
}

export function normalizeTelegramCommandToken(token: string): string {
  const canonicalToken = stripTelegramCommandMention(token);
  return COMMAND_ALIASES[canonicalToken] ?? canonicalToken;
}

export function extractTelegramCommand(text: string): { command?: string; argsText: string; bodyText: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { argsText: '', bodyText: trimmed };
  }

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return {
      command: normalizeTelegramCommandToken(trimmed),
      argsText: '',
      bodyText: '',
    };
  }

  const firstToken = normalizeTelegramCommandToken(trimmed.slice(0, firstSpace));
  const remainder = trimmed.slice(firstSpace + 1).trim();

  return {
    command: firstToken,
    argsText: remainder,
    bodyText: remainder,
  };
}

export function extractTrailingAgentCommand(text: string): { bodyText: string; agentType?: string; model?: string } {
  const trimmed = text.trim();
  if (!trimmed.includes('/')) {
    return { bodyText: trimmed };
  }

  const tokens = trimmed.split(/\s+/);
  const lastToken = normalizeTelegramCommandToken(tokens[tokens.length - 1]);
  const agentType = AGENT_COMMANDS[lastToken];
  if (!agentType) {
    return { bodyText: trimmed };
  }

  const bodyText = tokens.slice(0, -1).join(' ').trim();
  return {
    bodyText,
    agentType,
    model: getDefaultModelForAgent(agentType),
  };
}

function normalizeRuntime(value: string): AgentRuntime | undefined {
  const lower = value.toLowerCase();
  return RUNTIME_VALUES.find(runtime => runtime === lower);
}

function normalizeClaudePermissionMode(value: string): ClaudePermissionMode | undefined {
  return CLAUDE_PERMISSION_VALUES.find(mode => mode === value);
}

function normalizeCodexSandbox(value: string): CodexSandboxMode | undefined {
  return CODEX_SANDBOX_VALUES.find(mode => mode === value);
}

function parseBooleanFlag(value: string): boolean | undefined {
  const lower = value.toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(lower)) return true;
  if (['off', 'false', 'no', '0'].includes(lower)) return false;
  return undefined;
}

function defaultModelForRuntime(runtime: AgentRuntime, model?: string): string {
  if (model?.trim()) return model;
  if (runtime === 'codex') return DEFAULT_CODEX_MODEL;
  if (runtime === 'claude') return DEFAULT_CLAUDE_MODEL;
  return 'default';
}

function buildModelListText(
  runtimeLabel: string,
  models: readonly { id: string; label: string; tier?: string }[],
  command: string,
): string {
  return [
    `${runtimeLabel} 사용 가능한 모델 id`,
    ...models.map(model => {
      const tier = model.tier ? `, ${model.tier}` : '';
      return `- ${model.id} (${model.label}${tier})`;
    }),
    '',
    `설정: ${command} <model id>`,
  ].join('\n');
}

function buildInvalidModelText(
  runtimeLabel: string,
  requestedModel: string,
  models: readonly { id: string; label: string; tier?: string }[],
  command: string,
): string {
  return [
    `❌ 지원하지 않는 ${runtimeLabel} 모델입니다: ${requestedModel}`,
    '정확한 model id를 입력하세요.',
    '',
    buildModelListText(runtimeLabel, models, command),
  ].join('\n');
}

function extractLeadingAgentCommand(text: string): { bodyText: string; agentType?: string; model?: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { bodyText: trimmed };

  const { command, bodyText } = extractTelegramCommand(trimmed);
  const agentType = command ? AGENT_COMMANDS[command] : undefined;
  if (!agentType) return { bodyText: trimmed };
  const normalizedAgent = normalizeAgentType(agentType) ?? agentType;
  return {
    bodyText,
    agentType: normalizedAgent,
    model: getDefaultModelForAgent(normalizedAgent),
  };
}

function buildRuntimeStatusText(context: TelegramCommandContext): string {
  return [
    '⚙️ 현재 Telegram 기본 실행 설정',
    `- 런타임: ${formatRuntime(context.defaultAgentRuntime ?? 'opencode')}`,
    `- 에이전트: ${getPrimaryAgentDisplayLabel(context.defaultAgentType) ?? context.defaultAgentType ?? 'Default'}`,
    `- 모델: ${context.defaultModel ?? defaultModelForRuntime(context.defaultAgentRuntime ?? 'opencode')}`,
    `- 디렉토리: ${context.defaultProjectDir ?? 'not set'}`,
    `- Claude 권한: ${context.defaultClaudePermissionMode ?? 'acceptEdits'}`,
    `- Claude 권한 스킵: ${context.defaultClaudeDangerouslySkipPermissions ? 'on' : 'off'}`,
    `- Codex sandbox: ${context.defaultCodexSandbox ?? 'workspace-write'}`,
    '',
    '변경: /runtime codex|claude|opencode',
  ].join('\n');
}

export function buildTelegramSessionsText(sessions: TelegramSessionSummary[], selectedSessionId?: string): string {
  if (sessions.length === 0) {
    return '📭 현재 연결된 세션이 없습니다. 일반 메시지를 보내면 새 카드가 생성됩니다.';
  }

  const lines = ['📚 세션 목록'];
  for (const session of sessions) {
    const isSelected = session.sessionId === selectedSessionId;
    const label = getPrimaryAgentDisplayLabel(session.agentType) ?? session.agentType ?? 'Default';
    lines.push(
      '',
      `${isSelected ? '👉 ' : ''}${session.index}. ${session.title}`,
      `- 런타임: ${formatRuntime(session.agentRuntime)}`,
      `- 카드: ${session.cardId}`,
      `- 상태: ${session.status}`,
      `- 에이전트: ${label}`,
      `- 모델: ${session.model ?? 'default'}`,
    );
  }

  lines.push('', '세션 전환: /switch_session 3 또는 /세션변경 3');
  return lines.join('\n');
}

export function buildTelegramSessionInfoText(
  session: TelegramSessionSummary | undefined,
  pinnedMode: boolean,
): string {
  if (!session) {
    return 'ℹ️ 현재 선택된 세션이 없습니다. /sessions 로 목록을 확인하거나 새 메시지로 작업을 시작하세요.';
  }

  return [
    'ℹ️ 현재 세션 정보',
    `- 세션: ${session.index}. ${session.title}`,
    `- 런타임: ${formatRuntime(session.agentRuntime)}`,
    `- 카드: ${session.cardId}`,
    `- 상태: ${session.status}`,
    `- 에이전트: ${getPrimaryAgentDisplayLabel(session.agentType) ?? session.agentType ?? 'Default'}`,
    `- 모델: ${session.model ?? 'default'}`,
    `- 모드: ${pinnedMode ? 'pinned' : 'auto'}`,
  ].join('\n');
}

export function resolveTelegramCommand(
  text: string,
  context: TelegramCommandContext,
  pinnedMode: boolean,
): TelegramCommandResult | null {
  const { command, argsText, bodyText } = extractTelegramCommand(text);
  if (!command) return null;

  if (command === '/sessions') {
    return { type: 'reply', text: buildTelegramSessionsText(context.sessions, context.selectedSessionId) };
  }

  if (command === '/session_info') {
    const session = context.sessions.find(item => item.sessionId === context.selectedSessionId)
      ?? context.sessions[0];
    return { type: 'reply', text: buildTelegramSessionInfoText(session, pinnedMode) };
  }

  if (command === '/switch_session') {
    const targetIndex = Number.parseInt(argsText, 10);
    if (!Number.isFinite(targetIndex)) {
      return { type: 'reply', text: '사용법: /switch_session 3 또는 /세션변경 3' };
    }
    const target = context.sessions.find(session => session.index === targetIndex);
    if (!target) {
      return { type: 'reply', text: `❌ ${targetIndex}번 세션을 찾지 못했습니다. /sessions 로 목록을 확인하세요.` };
    }
    return {
      type: 'select-session',
      text: `✅ ${target.index}번 ${formatRuntime(target.agentRuntime)} 세션으로 전환했습니다. 이후 메시지는 이 세션으로 전달됩니다.`,
      sessionId: target.sessionId,
      cardId: target.cardId,
      agentRuntime: target.agentRuntime,
    };
  }

  if (command === '/new_session') {
    return {
      type: 'reply',
      text: '🆕 다음 메시지부터 새 세션으로 시작합니다. 현재 기본 에이전트/모델 설정은 유지됩니다.',
    };
  }

  if (command === '/runtime') {
    if (!argsText.trim()) {
      return { type: 'reply', text: buildRuntimeStatusText(context) };
    }
    const runtime = normalizeRuntime(argsText.trim());
    if (!runtime) {
      return { type: 'reply', text: '사용법: /runtime codex 또는 /runtime claude 또는 /runtime opencode' };
    }
    return {
      type: 'set-defaults',
      text: [
        `✅ 기본 런타임을 ${formatRuntime(runtime)}로 설정했습니다.`,
        `- 모델: ${defaultModelForRuntime(runtime, context.defaultAgentRuntime === runtime ? context.defaultModel : undefined)}`,
        '- 다음 일반 메시지부터 이 런타임으로 새 세션을 시작합니다.',
      ].join('\n'),
      agentRuntime: runtime,
      agentType: runtime === 'opencode' ? context.defaultAgentType : null,
      model: runtime === 'codex'
        ? DEFAULT_CODEX_MODEL
        : runtime === 'claude'
          ? DEFAULT_CLAUDE_MODEL
          : context.defaultAgentRuntime === 'opencode' ? context.defaultModel ?? null : null,
    };
  }

  if (command === '/codex' || command === '/claude' || command === '/opencode') {
    const runtime = command.slice(1) as AgentRuntime;
    let finalText = bodyText.trim();
    let agentType: string | undefined;
    const runtimeModel = context.defaultAgentRuntime === runtime ? context.defaultModel : undefined;
    let model = runtime === 'codex'
      ? runtimeModel ?? DEFAULT_CODEX_MODEL
      : runtime === 'claude'
        ? runtimeModel ?? DEFAULT_CLAUDE_MODEL
        : runtimeModel;

    if (runtime === 'opencode') {
      const leadingAgent = extractLeadingAgentCommand(finalText);
      finalText = leadingAgent.bodyText.trim();
      agentType = leadingAgent.agentType ?? context.defaultAgentType;
      model = leadingAgent.model ?? getDefaultModelForAgent(agentType) ?? model;
    }

    if (!finalText) {
      return {
        type: 'set-defaults',
        text: [
          `✅ 기본 런타임을 ${formatRuntime(runtime)}로 설정했습니다.`,
          `- 모델: ${defaultModelForRuntime(runtime, model)}`,
          '- 즉시 작업을 시작하려면 작업 내용을 함께 보내세요.',
        ].join('\n'),
        agentRuntime: runtime,
        agentType: runtime === 'opencode' ? agentType ?? null : null,
        model: runtime === 'opencode' ? model ?? null : defaultModelForRuntime(runtime, model),
      };
    }

    return {
      type: 'dispatch',
      text: finalText,
      forceNewSession: true,
      agentRuntime: runtime,
      agentType: runtime === 'opencode' ? agentType : undefined,
      model: runtime === 'opencode' ? model : defaultModelForRuntime(runtime, model),
      projectDir: context.defaultProjectDir,
      claudePermissionMode: context.defaultClaudePermissionMode,
      claudeDangerouslySkipPermissions: context.defaultClaudeDangerouslySkipPermissions,
      codexSandbox: context.defaultCodexSandbox,
    };
  }

  if (command === '/codex_model_list') {
    return {
      type: 'reply',
      text: buildModelListText('Codex', CODEX_MODELS, '/codex_model'),
    };
  }

  if (command === '/codex_model') {
    const model = argsText.trim();
    if (!model) {
      return {
        type: 'reply',
        text: buildModelListText('Codex', CODEX_MODELS, '/codex_model'),
      };
    }
    if (!isCodexModelValid(model)) {
      return {
        type: 'reply',
        text: buildInvalidModelText('Codex', model, CODEX_MODELS, '/codex_model'),
      };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ Codex 기본 모델을 설정했습니다.',
        `- 모델: ${model}`,
        '- 다음 Codex 작업부터 적용됩니다.',
      ].join('\n'),
      agentRuntime: 'codex',
      agentType: null,
      model,
    };
  }

  if (command === '/claude_model_list') {
    return {
      type: 'reply',
      text: buildModelListText('Claude', CLAUDE_MODELS, '/claude_model'),
    };
  }

  if (command === '/claude_model') {
    const model = argsText.trim();
    if (!model) {
      return {
        type: 'reply',
        text: buildModelListText('Claude', CLAUDE_MODELS, '/claude_model'),
      };
    }
    if (!isClaudeModelValid(model)) {
      return {
        type: 'reply',
        text: buildInvalidModelText('Claude', model, CLAUDE_MODELS, '/claude_model'),
      };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ Claude 기본 모델을 설정했습니다.',
        `- 모델: ${model}`,
        '- 다음 Claude 작업부터 적용됩니다.',
      ].join('\n'),
      agentRuntime: 'claude',
      agentType: null,
      model,
    };
  }

  if (command === '/directory') {
    const projectDir = argsText.trim();
    if (!projectDir) {
      return {
        type: 'reply',
        text: `현재 기본 디렉토리: ${context.defaultProjectDir ?? 'not set'}\n변경: /directory /path/to/project\n해제: /directory clear`,
      };
    }
    if (projectDir.toLowerCase() === 'clear') {
      return {
        type: 'set-defaults',
        text: '✅ 기본 디렉토리 설정을 해제했습니다.',
        projectDir: null,
      };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ 기본 디렉토리를 설정했습니다.',
        `- 디렉토리: ${projectDir}`,
        '- 다음 새 작업부터 이 디렉토리에서 실행합니다.',
      ].join('\n'),
      projectDir,
    };
  }

  if (command === '/claude_permission') {
    const permissionMode = normalizeClaudePermissionMode(argsText.trim());
    if (!permissionMode) {
      return { type: 'reply', text: '사용법: /claude_permission acceptEdits|bypassPermissions|plan|dontAsk' };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ Claude 권한 모드를 설정했습니다.',
        `- 권한: ${permissionMode}`,
      ].join('\n'),
      agentRuntime: 'claude',
      claudePermissionMode: permissionMode,
    };
  }

  if (command === '/claude_skip_permissions') {
    const enabled = parseBooleanFlag(argsText.trim());
    if (enabled === undefined) {
      return { type: 'reply', text: '사용법: /claude_skip_permissions on 또는 /claude_skip_permissions off' };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ Claude 권한 스킵 설정을 변경했습니다.',
        `- 권한 스킵: ${enabled ? 'on' : 'off'}`,
      ].join('\n'),
      agentRuntime: 'claude',
      claudeDangerouslySkipPermissions: enabled,
    };
  }

  if (command === '/codex_sandbox') {
    const sandbox = normalizeCodexSandbox(argsText.trim());
    if (!sandbox) {
      return { type: 'reply', text: '사용법: /codex_sandbox read-only|workspace-write|danger-full-access' };
    }
    return {
      type: 'set-defaults',
      text: [
        '✅ Codex sandbox를 설정했습니다.',
        `- sandbox: ${sandbox}`,
      ].join('\n'),
      agentRuntime: 'codex',
      codexSandbox: sandbox,
    };
  }

  const agentType = AGENT_COMMANDS[command];
  if (agentType) {
    const normalizedAgent = normalizeAgentType(agentType) ?? agentType;
    const finalText = bodyText.trim();
    if (!finalText) {
      return {
        type: 'set-defaults',
        text: [
          `✅ 기본 에이전트를 ${getPrimaryAgentDisplayLabel(normalizedAgent) ?? normalizedAgent}로 설정했습니다.`,
          `- 모델: ${getDefaultModelForAgent(normalizedAgent) ?? 'default'}`,
          '- 다음 메시지부터 Opencode에서 이 에이전트로 새 세션을 시작합니다.',
          `- 즉시 작업을 시작하려면 작업 내용을 함께 보내세요. 예) 로그인 버그를 수정해줘 ${command}`,
        ].join('\n'),
        agentRuntime: 'opencode',
        agentType: normalizedAgent,
        model: getDefaultModelForAgent(normalizedAgent),
      };
    }
    return {
      type: 'dispatch',
      text: finalText,
      forceNewSession: true,
      agentRuntime: 'opencode',
      agentType: normalizedAgent,
      model: getDefaultModelForAgent(normalizedAgent),
    };
  }

  if (command === '/help') {
    return {
      type: 'reply',
      text: buildTelegramHelpText(),
    };
  }

  return {
    type: 'reply',
    text: `알 수 없는 명령입니다: ${command}\n/help 로 사용 가능한 명령을 확인하세요.`,
  };
}
