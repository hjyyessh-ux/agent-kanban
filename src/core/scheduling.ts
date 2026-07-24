import type {
  AgentRuntime,
  BashSchedulerAction,
  CreateScheduledDispatchInput,
  KanbanCard,
  PromptSchedulerAction,
  SchedulerScheduleInputState,
  SchedulerSimpleRepeat,
  ScheduledDispatchState,
  ScheduledDispatchStatus,
  SchedulerAction,
  SchedulerEntry,
  SchedulerRun,
  SchedulerStatus,
} from './types';
import { describeCron } from './cron-parser';

export const SCHEDULER_TIMEZONE = 'Asia/Seoul' as const;
export const SCHEDULER_CRON_FIELD_HINT = 'minute hour day month weekday';

const KST_OFFSET_HOURS = 9;
const KST_OFFSET_MS = KST_OFFSET_HOURS * 60 * 60 * 1000;
const KST_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const FIVE_FIELD_CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const VALID_CRON_FIELD_RE = /^(\*|\*\/\d+|\d+|\d+-\d+|\d+(?:,\d+)+|\d+-\d+\/\d+)$/;
const DAY_OF_WEEK_LABELS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'] as const;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asOptionalRuntime(value: unknown): AgentRuntime | undefined {
  return value === 'opencode' || value === 'codex' || value === 'claude' ? value : undefined;
}

function asOptionalStatus(value: unknown): SchedulerStatus | undefined {
  return value === 'active' || value === 'inactive' ? value : undefined;
}

function asOptionalScheduledDispatchStatus(value: unknown): ScheduledDispatchStatus | undefined {
  return value === 'scheduled'
    || value === 'dispatching'
    || value === 'dispatched'
    || value === 'failed'
    ? value
    : undefined;
}

export function parseKstDateTimeInputToUtcIso(value: string): string {
  const trimmed = value.trim();
  const match = KST_INPUT_RE.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid KST datetime input: ${value}`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');

  const utcMs = Date.UTC(year, month - 1, day, hour - KST_OFFSET_HOURS, minute, second);
  const date = new Date(utcMs);
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  if (
    shifted.getUTCFullYear() !== year
    || shifted.getUTCMonth() !== month - 1
    || shifted.getUTCDate() !== day
    || shifted.getUTCHours() !== hour
    || shifted.getUTCMinutes() !== minute
    || shifted.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid KST datetime input: ${value}`);
  }

  return date.toISOString();
}

export function validateScheduledAtKstInput(value: unknown, now = new Date()): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('scheduledAt is required and must be a KST datetime string');
  }
  const scheduledAt = parseKstDateTimeInputToUtcIso(value);
  if (scheduledAt <= now.toISOString()) {
    throw new Error('scheduledAt must be a future KST datetime');
  }
  return scheduledAt;
}

export function formatUtcIsoToKstInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC datetime: ${value}`);
  }
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export function validateSchedulerTimezoneInput(value: unknown): typeof SCHEDULER_TIMEZONE {
  if (value === undefined || value === null || value === '') {
    return SCHEDULER_TIMEZONE;
  }
  if (value !== SCHEDULER_TIMEZONE) {
    throw new Error(`timezone must be ${SCHEDULER_TIMEZONE}`);
  }
  return SCHEDULER_TIMEZONE;
}

function validateHour(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error('시간은 0-23 범위여야 합니다.');
  }
  return value;
}

function validateMinute(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 59) {
    throw new Error('분은 0-59 범위여야 합니다.');
  }
  return value;
}

function validateInterval(value: number | undefined, repeat: SchedulerSimpleRepeat): number {
  const max = repeat === 'minutes' ? 59 : 23;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(repeat === 'minutes'
      ? '분 간격은 1-59 범위여야 합니다.'
      : '시간 간격은 1-23 범위여야 합니다.');
  }
  return value;
}

function validateDayOfWeek(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error('요일은 0(일)부터 6(토) 사이여야 합니다.');
  }
  return value;
}

function formatKstTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function isValidFiveFieldCronField(field: string): boolean {
  return VALID_CRON_FIELD_RE.test(field);
}

export function isValidFiveFieldCron(expr: string): boolean {
  const match = FIVE_FIELD_CRON_RE.exec(expr.trim());
  if (!match) return false;
  return match.slice(1).every(isValidFiveFieldCronField);
}

export interface ResolvedSchedulerScheduleInput {
  cron: string;
  cronDescription: string;
  scheduleInput: SchedulerScheduleInputState;
  preview: string;
}

export function resolveSchedulerScheduleInput(input: SchedulerScheduleInputState): ResolvedSchedulerScheduleInput {
  if (input.mode === 'simple') {
    const repeat = input.simple.repeat;
    if (repeat === 'minutes') {
      const interval = validateInterval(input.simple.interval, 'minutes');
      return {
        cron: `*/${interval} * * * *`,
        cronDescription: `매 ${interval}분마다`,
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'minutes', interval },
        },
        preview: `KST 실행: 매 ${interval}분마다`,
      };
    }

    if (repeat === 'hours') {
      const interval = validateInterval(input.simple.interval, 'hours');
      const minute = validateMinute(input.simple.minute);
      return {
        cron: `${minute} */${interval} * * *`,
        cronDescription: `매 ${interval}시간마다 ${pad(minute)}분`,
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'hours', interval, minute },
        },
        preview: `KST 실행: 매 ${interval}시간마다 ${pad(minute)}분`,
      };
    }

    if (repeat === 'daily') {
      const hour = validateHour(input.simple.hour);
      const minute = validateMinute(input.simple.minute);
      return {
        cron: `${minute} ${hour} * * *`,
        cronDescription: `매일 ${formatKstTime(hour, minute)}`,
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'daily', hour, minute },
        },
        preview: `KST 실행: 매일 ${formatKstTime(hour, minute)}`,
      };
    }

    if (repeat === 'weekdays') {
      const hour = validateHour(input.simple.hour);
      const minute = validateMinute(input.simple.minute);
      return {
        cron: `${minute} ${hour} * * 1-5`,
        cronDescription: `평일 ${formatKstTime(hour, minute)}`,
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'weekdays', hour, minute },
        },
        preview: `KST 실행: 평일 ${formatKstTime(hour, minute)}`,
      };
    }

    if (repeat === 'weekly') {
      const dayOfWeek = validateDayOfWeek(input.simple.dayOfWeek);
      const hour = validateHour(input.simple.hour);
      const minute = validateMinute(input.simple.minute);
      return {
        cron: `${minute} ${hour} * * ${dayOfWeek}`,
        cronDescription: `${DAY_OF_WEEK_LABELS[dayOfWeek]} ${formatKstTime(hour, minute)}`,
        scheduleInput: {
          mode: 'simple',
          simple: { repeat: 'weekly', dayOfWeek, hour, minute },
        },
        preview: `KST 실행: ${DAY_OF_WEEK_LABELS[dayOfWeek]} ${formatKstTime(hour, minute)}`,
      };
    }

    throw new Error('지원하지 않는 간편 설정입니다.');
  }

  const expression = input.expression.trim();
  if (!expression) {
    throw new Error('Cron 직접 입력값이 필요합니다.');
  }
  if (!isValidFiveFieldCron(expression)) {
    throw new Error(`Cron 직접 입력은 5개 필드(${SCHEDULER_CRON_FIELD_HINT})만 지원합니다.`);
  }
  return {
    cron: expression,
    cronDescription: expression,
    scheduleInput: { mode: 'cron', expression },
    preview: `KST 실행: ${describeCron(expression)}`,
  };
}

function inferSimpleScheduleFromCron(cron: string): SchedulerScheduleInputState | null {
  const match = FIVE_FIELD_CRON_RE.exec(cron.trim());
  if (!match) return null;
  const [, minute, hour, dayOfMonth, month, dayOfWeek] = match;
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && /^\*\/\d+$/.test(minute)) {
    return {
      mode: 'simple',
      simple: {
        repeat: 'minutes',
        interval: Number(minute.slice(2)),
      },
    };
  }
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && /^\d+$/.test(minute) && /^\*\/\d+$/.test(hour)) {
    return {
      mode: 'simple',
      simple: {
        repeat: 'hours',
        interval: Number(hour.slice(2)),
        minute: Number(minute),
      },
    };
  }
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return {
      mode: 'simple',
      simple: {
        repeat: 'daily',
        hour: Number(hour),
        minute: Number(minute),
      },
    };
  }
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return {
      mode: 'simple',
      simple: {
        repeat: 'weekdays',
        hour: Number(hour),
        minute: Number(minute),
      },
    };
  }
  if (dayOfMonth === '*' && month === '*' && /^[0-6]$/.test(dayOfWeek) && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return {
      mode: 'simple',
      simple: {
        repeat: 'weekly',
        dayOfWeek: Number(dayOfWeek),
        hour: Number(hour),
        minute: Number(minute),
      },
    };
  }
  return null;
}

export function inferSchedulerScheduleInput(
  cron: string,
  scheduleInput?: SchedulerScheduleInputState,
): SchedulerScheduleInputState {
  if (scheduleInput) {
    return scheduleInput;
  }
  return inferSimpleScheduleFromCron(cron) ?? { mode: 'cron', expression: cron };
}

function normalizeSchedulerScheduleInput(raw: unknown, cron: string): SchedulerScheduleInputState | undefined {
  if (!isRecord(raw)) {
    return inferSimpleScheduleFromCron(cron) ?? { mode: 'cron', expression: cron };
  }

  if (raw.mode === 'simple' && isRecord(raw.simple)) {
    const repeat = asOptionalString(raw.simple.repeat);
    if (
      repeat === 'minutes'
      || repeat === 'hours'
      || repeat === 'daily'
      || repeat === 'weekdays'
      || repeat === 'weekly'
    ) {
      return {
        mode: 'simple',
        simple: {
          repeat,
          interval: typeof raw.simple.interval === 'number' ? raw.simple.interval : undefined,
          hour: typeof raw.simple.hour === 'number' ? raw.simple.hour : undefined,
          minute: typeof raw.simple.minute === 'number' ? raw.simple.minute : undefined,
          dayOfWeek: typeof raw.simple.dayOfWeek === 'number' ? raw.simple.dayOfWeek : undefined,
        },
      };
    }
  }

  if (raw.mode === 'cron') {
    const expression = asOptionalString(raw.expression)?.trim();
    if (expression) {
      return { mode: 'cron', expression };
    }
  }

  return inferSimpleScheduleFromCron(cron) ?? { mode: 'cron', expression: cron };
}

export function isTopLevelTodoCard(card: KanbanCard): boolean {
  return card.status === 'todo' && !card.parentCardId;
}

export function hasQueueConfig(card: Pick<KanbanCard, 'queuedAfterCardId' | 'queuePosition' | 'queueSessionMode'>): boolean {
  return card.queuedAfterCardId !== undefined
    || card.queuePosition !== undefined
    || card.queueSessionMode !== undefined;
}

export function hasActiveScheduledDispatch(card: Pick<KanbanCard, 'scheduledDispatch'>): boolean {
  return card.scheduledDispatch?.status === 'scheduled' || card.scheduledDispatch?.status === 'dispatching';
}

export function createScheduledDispatchState(scheduledAt: string, updatedAt: string): ScheduledDispatchState {
  return {
    scheduledAt: new Date(scheduledAt).toISOString(),
    status: 'scheduled',
    updatedAt,
  };
}

export function validateCreateScheduledDispatchInput(
  value: unknown,
  now = new Date(),
): CreateScheduledDispatchInput {
  if (!isRecord(value)) {
    throw new Error('scheduledDispatch must be an object');
  }

  const scheduledAt = asOptionalString(value.scheduledAt);
  if (!scheduledAt) {
    throw new Error('scheduledDispatch.scheduledAt is required');
  }

  const parsed = new Date(scheduledAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('scheduledDispatch.scheduledAt must be a valid UTC datetime');
  }

  const normalized = parsed.toISOString();
  if (normalized <= now.toISOString()) {
    throw new Error('scheduledDispatch.scheduledAt must be a future datetime');
  }

  return { scheduledAt: normalized };
}

export function claimScheduledDispatchState(
  state: ScheduledDispatchState,
  updatedAt: string,
): ScheduledDispatchState {
  if (state.status !== 'scheduled') {
    throw new Error(`Scheduled dispatch is not claimable: ${state.status}`);
  }
  return {
    ...state,
    status: 'dispatching',
    error: undefined,
    updatedAt,
  };
}

export function recoverScheduledDispatchClaimState(
  state: ScheduledDispatchState,
  updatedAt: string,
): ScheduledDispatchState {
  if (state.status !== 'dispatching') {
    throw new Error(`Scheduled dispatch is not recoverable: ${state.status}`);
  }
  return {
    scheduledAt: state.scheduledAt,
    status: 'scheduled',
    updatedAt,
  };
}

export function finalizeScheduledDispatchState(
  state: ScheduledDispatchState,
  updatedAt: string,
  result: { status: 'dispatched' | 'failed'; dispatchedAt?: string; error?: string },
): ScheduledDispatchState {
  if (result.status === 'dispatched') {
    return {
      ...state,
      status: 'dispatched',
      dispatchedAt: new Date(result.dispatchedAt ?? updatedAt).toISOString(),
      error: undefined,
      updatedAt,
    };
  }

  return {
    ...state,
    status: 'failed',
    dispatchedAt: undefined,
    error: result.error,
    updatedAt,
  };
}

export function validateCardScheduleEligibility(card: KanbanCard): void {
  if (!isTopLevelTodoCard(card)) {
    throw new Error(`Only top-level todo cards can be scheduled: ${card.id}`);
  }
  if (hasQueueConfig(card)) {
    throw new Error(`Queued cards cannot also be scheduled: ${card.id}`);
  }
}

export function validateQueueCompatibility(card: KanbanCard): void {
  if (hasActiveScheduledDispatch(card)) {
    throw new Error(`Scheduled cards cannot also be queued: ${card.id}`);
  }
}

export function normalizeScheduledDispatchState(raw: unknown): ScheduledDispatchState | undefined {
  if (!isRecord(raw)) return undefined;
  const scheduledAt = asOptionalString(raw.scheduledAt);
  const updatedAt = asOptionalString(raw.updatedAt);
  const status = asOptionalScheduledDispatchStatus(raw.status);
  if (!scheduledAt || !updatedAt || !status) {
    return undefined;
  }

  return {
    ...raw,
    scheduledAt: new Date(scheduledAt).toISOString(),
    status,
    dispatchedAt: asOptionalString(raw.dispatchedAt)
      ? new Date(asOptionalString(raw.dispatchedAt) as string).toISOString()
      : undefined,
    error: asOptionalString(raw.error),
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

export function validateSchedulerActionInput(action: unknown): SchedulerAction {
  if (!isRecord(action)) {
    throw new Error('action is required');
  }

  const type = asOptionalString(action.type);
  if (type === 'bash') {
    const command = asOptionalTrimmedString(action.command);
    if (!command) {
      throw new Error('bash action requires a non-empty command');
    }

    const bashAction: BashSchedulerAction = {
      type: 'bash',
      command,
      cwd: asOptionalTrimmedString(action.cwd),
      editState: action.editState === 'edit-required' ? 'edit-required' : 'ready',
    };
    return bashAction;
  }

  if (type === 'prompt') {
    const prompt = asOptionalTrimmedString(action.prompt);
    if (!prompt) {
      throw new Error('prompt action requires a non-empty prompt');
    }

    if (action.agentRuntime !== undefined && !asOptionalRuntime(action.agentRuntime)) {
      throw new Error('prompt action has invalid agentRuntime');
    }
    if (action.model !== undefined && !asOptionalTrimmedString(action.model)) {
      throw new Error('prompt action model must be a non-empty string');
    }
    if (action.projectDir !== undefined && !asOptionalTrimmedString(action.projectDir)) {
      throw new Error('prompt action projectDir must be a non-empty string');
    }

    const promptAction: PromptSchedulerAction = {
      type: 'prompt',
      prompt,
      projectDir: asOptionalTrimmedString(action.projectDir),
      agentRuntime: asOptionalRuntime(action.agentRuntime),
      model: asOptionalTrimmedString(action.model),
      codexOptions: isRecord(action.codexOptions) ? action.codexOptions : undefined,
      claudeOptions: isRecord(action.claudeOptions) ? action.claudeOptions : undefined,
      editState: action.editState === 'edit-required' ? 'edit-required' : 'ready',
    };
    return promptAction;
  }

  throw new Error('action.type must be "bash" or "prompt"');
}

export function normalizeSchedulerAction(action: unknown): {
  action: SchedulerAction;
  status: SchedulerStatus;
} {
  if (!isRecord(action)) {
    return {
      action: {
        type: 'bash',
        command: '',
        editState: 'edit-required',
      },
      status: 'inactive',
    };
  }

  const type = asOptionalString(action.type);
  if (type === 'bash') {
    return {
      action: {
        ...action,
        type: 'bash',
        command: asOptionalString(action.command) ?? '',
        cwd: asOptionalString(action.cwd),
        editState: action.editState === 'edit-required' ? 'edit-required' : 'ready',
      },
      status: 'active',
    };
  }

  if (type === 'prompt') {
    return {
      action: {
        ...action,
        type: 'prompt',
        prompt: asOptionalString(action.prompt) ?? '',
        projectDir: asOptionalString(action.projectDir),
        agentRuntime: asOptionalRuntime(action.agentRuntime),
        model: asOptionalString(action.model),
        codexOptions: isRecord(action.codexOptions) ? action.codexOptions : undefined,
        claudeOptions: isRecord(action.claudeOptions) ? action.claudeOptions : undefined,
        editState: action.editState === 'edit-required' ? 'edit-required' : 'ready',
      },
      status: 'active',
    };
  }

  if (type === 'shell') {
    return {
      action: {
        ...action,
        type: 'bash',
        command: asOptionalString(action.command) ?? '',
        cwd: asOptionalString(action.cwd),
        editState: 'ready',
        legacy: {
          type: 'shell',
          command: asOptionalString(action.command),
          cwd: asOptionalString(action.cwd),
        },
      },
      status: 'active',
    };
  }

  return {
    action: {
      ...action,
      type: 'prompt',
      prompt: '',
      projectDir: undefined,
      agentRuntime: undefined,
      model: undefined,
      editState: 'edit-required',
      legacy: {
        type: 'skill',
        command: asOptionalString(action.command),
        cwd: asOptionalString(action.cwd),
        skillName: asOptionalString(action.skillName),
        skillInput: asOptionalString(action.skillInput),
      },
    },
    status: 'inactive',
  };
}

export function normalizeSchedulerEntry(raw: unknown): SchedulerEntry | null {
  if (!isRecord(raw)) return null;

  const id = asOptionalString(raw.id);
  const name = asOptionalString(raw.name);
  const description = asOptionalString(raw.description);
  const cron = asOptionalString(raw.cron);
  const createdAt = asOptionalString(raw.createdAt);
  const updatedAt = asOptionalString(raw.updatedAt);
  const actionResult = normalizeSchedulerAction(raw.action);
  const requestedStatus = asOptionalStatus(raw.status) ?? 'active';
  const normalizedStatus = actionResult.action.editState === 'edit-required'
    ? 'inactive'
    : requestedStatus === 'inactive'
      ? 'inactive'
      : actionResult.status;

  if (
    id === undefined
    || name === undefined
    || description === undefined
    || cron === undefined
    || createdAt === undefined
    || updatedAt === undefined
  ) {
    return null;
  }

  return {
    ...raw,
    id,
    name,
    description,
    cron,
    cronDescription: asOptionalString(raw.cronDescription),
    scheduleInput: normalizeSchedulerScheduleInput(raw.scheduleInput, cron),
    timezone: SCHEDULER_TIMEZONE,
    status: normalizedStatus,
    action: actionResult.action,
    lastRunAt: asOptionalString(raw.lastRunAt),
    nextRunAt: asOptionalString(raw.nextRunAt),
    lastRunStatus: raw.lastRunStatus === 'success' || raw.lastRunStatus === 'fail' ? raw.lastRunStatus : undefined,
    history: Array.isArray(raw.history)
      ? raw.history
        .map((run) => normalizeSchedulerRun(run))
        .filter((run): run is SchedulerRun => run !== null)
      : [],
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

function normalizeSchedulerRun(raw: unknown): SchedulerRun | null {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  const schedulerId = asOptionalString(raw.schedulerId);
  const startedAt = asOptionalString(raw.startedAt);
  const status = raw.status === 'running' || raw.status === 'success' || raw.status === 'fail'
    ? raw.status
    : undefined;
  if (!id || !schedulerId || !startedAt || !status) {
    return null;
  }

  return {
    ...raw,
    id,
    schedulerId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: asOptionalString(raw.finishedAt)
      ? new Date(asOptionalString(raw.finishedAt) as string).toISOString()
      : undefined,
    status,
    cardId: asOptionalString(raw.cardId),
    dispatched: typeof raw.dispatched === 'boolean' ? raw.dispatched : undefined,
    dispatchAcceptedAt: asOptionalString(raw.dispatchAcceptedAt)
      ? new Date(asOptionalString(raw.dispatchAcceptedAt) as string).toISOString()
      : undefined,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
    stdout: asOptionalString(raw.stdout),
    stderr: asOptionalString(raw.stderr),
    error: asOptionalString(raw.error),
  };
}
