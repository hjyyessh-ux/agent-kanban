import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  KanbanCard,
  KanbanBoard,
  KanbanArchive,
  CreateCardInput,
  UpdateCardInput,
  KanbanStatus,
  Screenshot,
  CardWikiState,
  WikiStats,
  WikiDocType,
  WikiArchiveCardsQuery,
  WikiArchiveCardsResponse,
  WikiArchiveCardStatusFilter,
} from './types';
import { WIKI_INTERNAL_MARKER } from './types';
import { FileLock } from './filelock';
import { resolveDir } from './data-dir';
import { normalizeAgentType } from './agent-type';
import { normalizeRuntimeCommandId } from './commands';
import type { AgentRuntime } from './types';
import {
  claimScheduledDispatchState,
  createScheduledDispatchState,
  finalizeScheduledDispatchState,
  hasActiveScheduledDispatch,
  normalizeScheduledDispatchState,
  recoverScheduledDispatchClaimState,
  validateCardScheduleEligibility,
  validateCreateScheduledDispatchInput,
  validateQueueCompatibility,
} from './scheduling';

function inferAgentRuntime(input: Pick<CreateCardInput, 'agentRuntime' | 'sourceContext'>): AgentRuntime {
  if (input.agentRuntime) return input.agentRuntime;
  if (input.sourceContext === 'codex') return 'codex';
  if (input.sourceContext === 'claude-code') return 'claude';
  return 'opencode';
}

// Legacy status name used before the opencode_complete → complete rename.
// Existing on-disk data files may still carry the old value.
function migrateCardStatus(card: KanbanCard): KanbanCard {
  const migrated: KanbanCard = {
    ...card,
    agentRuntime: card.agentRuntime ?? 'opencode',
    scheduledDispatch: normalizeScheduledDispatchState(card.scheduledDispatch),
  };
  if ((migrated.status as string) === 'opencode_complete') {
    return { ...migrated, status: 'complete' };
  }
  return migrated;
}

function isActiveCard(card: KanbanCard): boolean {
  return !card.deletedAt;
}

function isWikiEligibleCard(card: KanbanCard): boolean {
  return isActiveCard(card) && !card.parentCardId;
}

interface WikiArchiveCursor {
  v: 1;
  month: string;
  offset: number;
}

function encodeWikiArchiveCursor(cursor: WikiArchiveCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeWikiArchiveCursor(value: string): WikiArchiveCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<WikiArchiveCursor>;
    if (
      parsed.v !== 1
      || typeof parsed.month !== 'string'
      || !/^\d{4}-\d{2}$/.test(parsed.month)
      || typeof parsed.offset !== 'number'
      || !Number.isInteger(parsed.offset)
      || parsed.offset < 0
    ) {
      throw new Error('Invalid archive cursor');
    }
    return { v: 1, month: parsed.month, offset: parsed.offset };
  } catch {
    throw new Error('Invalid archive cursor');
  }
}

function matchesWikiArchiveStatus(card: KanbanCard, filter: WikiArchiveCardStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unprocessed') return !card.wiki;
  if (!card.wiki) return false;
  if (filter === 'kept') return card.wiki.decision === 'kept';
  if (filter === 'skipped') return card.wiki.decision === 'skipped';
  if (filter === 'failed') return card.wiki.status === 'failed';
  if (filter === 'pending') return card.wiki.status === 'pending';
  return true;
}

function matchesWikiArchiveSearch(card: KanbanCard, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  // Archive Cards search targets the card itself — title, prompt (description),
  // and project — not the generated wiki document fields.
  const haystack = [
    card.title,
    card.description,
    card.projectDir,
    card.sessionTitle,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

function migrateStatuses(board: KanbanBoard): KanbanBoard {
  return { ...board, cards: board.cards.map(migrateCardStatus) };
}

export class KanbanStore {
  private readonly dataDir: string;
  private readonly activePath: string;
  private readonly archiveDir: string;
  private readonly legacyBoardPath: string;
  private readonly tmpPath: string;
  private readonly screenshotDir: string;
  private readonly fileLock: FileLock;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolveDir(dataDir);
    this.activePath = join(this.dataDir, 'active.json');
    this.archiveDir = join(this.dataDir, 'archive');
    this.screenshotDir = join(this.dataDir, 'screenshots');
    this.legacyBoardPath = join(this.dataDir, 'board.json');
    this.tmpPath = join(this.dataDir, '.active.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.board.json.lock'));
  }

  /**
   * Dual locking: in-process mutex + cross-process FileLock.
   * In-process mutex serializes concurrent calls within the same process.
   * FileLock serializes across separate OS processes.
   */
  private async withDualLock<T>(fn: () => Promise<T>): Promise<T> {
    // 1. Acquire in-process mutex
    let release: () => void;
    const prev = this.lockPromise;
    this.lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;

    try {
      // 2. Acquire cross-process file lock, then execute fn
      return await this.fileLock.withLock(fn);
    } finally {
      release!();
    }
  }

  async load(): Promise<KanbanBoard> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Active file exists → read it
    if (existsSync(this.activePath)) {
      const content = await Bun.file(this.activePath).text();
      return migrateStatuses(JSON.parse(content) as KanbanBoard);
    }

    // Legacy migration: board.json → active.json
    if (existsSync(this.legacyBoardPath)) {
      const content = await Bun.file(this.legacyBoardPath).text();
      const board = migrateStatuses(JSON.parse(content) as KanbanBoard);
      // Write to active.json atomically
      await Bun.write(this.tmpPath, JSON.stringify(board, null, 2));
      renameSync(this.tmpPath, this.activePath);
      // Backup legacy file
      renameSync(this.legacyBoardPath, this.legacyBoardPath + '.bak');
      return board;
    }

    return this.defaultBoard();
  }

  async save(board: KanbanBoard): Promise<void> {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    await Bun.write(this.tmpPath, JSON.stringify(board, null, 2));
    renameSync(this.tmpPath, this.activePath);
  }

  async createCard(input: CreateCardInput): Promise<KanbanCard> {
    // Pre-build card OUTSIDE the lock
    const now = new Date().toISOString();
    const agentRuntime = inferAgentRuntime(input);
    const scheduledDispatchInput = input.scheduledDispatch
      ? validateCreateScheduledDispatchInput(input.scheduledDispatch)
      : undefined;
    if (scheduledDispatchInput && input.queueSessionMode) {
      throw new Error('Queued cards cannot also be scheduled');
    }
    const card: KanbanCard = {
      id: nanoid(),
      title: input.title,
      description: input.description,
      status: 'todo',
      sessionId: input.sessionId,
      projectDir: input.projectDir,
      model: input.model,
      agentRuntime,
      codexOptions: input.codexOptions,
      claudeOptions: input.claudeOptions,
      parentCardId: input.parentCardId,
      linkKind: input.linkKind,
      childTaskId: input.childTaskId,
      childToolUseId: input.childToolUseId,
      childRunId: input.childRunId,
      rootCardId: input.rootCardId,
      agentType: normalizeAgentType(input.agentType),
      messageId: input.messageId,
      command: normalizeRuntimeCommandId(input.command, agentRuntime),
      arguments: input.arguments,
      skills: input.skills,
      sourceContext: input.sourceContext,
      sessionTitle: input.sessionTitle,
      sessionCreatedAt: input.sessionCreatedAt,
      feedbackForCardId: input.feedbackForCardId,
      scheduledDispatch: scheduledDispatchInput
        ? createScheduledDispatchState(scheduledDispatchInput.scheduledAt, now)
        : undefined,
      queueSessionMode: input.queueSessionMode,
      resumeSessionId: input.resumeSessionId,
      dispatchType: input.dispatchType,
      telegramChatId: input.telegramChatId,
      originChannel: input.originChannel,
      schedulerId: input.schedulerId,
      schedulerRunId: input.schedulerRunId,
      schedulerName: input.schedulerName,
      telegramMessageId: input.telegramMessageId,
      telegramReplyStatus: input.telegramReplyStatus,
      telegramReplyMessageId: input.telegramReplyMessageId,
      telegramReplyError: input.telegramReplyError,
      telegramReplyUpdatedAt: input.telegramReplyUpdatedAt,
      createdAt: now,
      updatedAt: now,
    };

    // Safety guard (defense-in-depth): wiki worker one-shot prompts carry the
    // wiki-internal sentinel. The CLI hooks set WIKI_INTERNAL_ENV to skip card
    // creation upstream, but if any caller path slips through, never persist a
    // card whose title/description begins with the marker — otherwise it shows
    // on the board and accumulates in active.json. startsWith (not includes) so
    // a human card that merely quotes the marker is unaffected.
    const isWikiInternal =
      (input.title?.startsWith(WIKI_INTERNAL_MARKER) ?? false) ||
      (input.description?.startsWith(WIKI_INTERNAL_MARKER) ?? false);
    if (isWikiInternal) {
      return card;
    }

    if (card.scheduledDispatch) {
      validateCardScheduleEligibility(card);
    }

    // Lock only covers read→merge→write
    await this.withDualLock(async () => {
      const board = await this.load();
      board.cards.push(card);
      board.lastModified = new Date().toISOString();
      await this.save(board);
    });

    return card;
  }

  async updateCard(id: string, input: UpdateCardInput): Promise<KanbanCard> {
    // Pre-build the partial update outside the lock
    const updates = {
      ...input,
      ...(input.agentType !== undefined
        ? { agentType: input.agentType === null ? null : normalizeAgentType(input.agentType) }
        : {}),
    };
    const now = new Date().toISOString();

    let updatedCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const index = board.cards.findIndex(c => c.id === id);
      if (index === -1) {
        throw new Error(`Card not found: ${id}`);
      }
      // Separate null (=delete) fields from normal updates
      const {
        queuedAfterCardId,
        queuePosition,
        queueSessionMode,
        staleStatus,
        staleDetectedAt,
        scheduledDispatch,
        model,
        agentRuntime,
        agentType,
        command,
        arguments: commandArguments,
        codexOptions,
        claudeOptions,
        resumeSessionId,
        resolution,
        supersededByCardId,
        supersededAt,
        originChannel,
        schedulerId,
        schedulerRunId,
        schedulerName,
        telegramMessageId,
        telegramReplyStatus,
        telegramReplyMessageId,
        telegramReplyError,
        telegramReplyUpdatedAt,
        responseAt,
        startedAt,
        completedAt,
        durationMs,
        completedSeenAt,
        ...safeUpdates
      } = updates;
      const previousStatus = board.cards[index].status;
      const runtimeForCommand = agentRuntime ?? board.cards[index].agentRuntime ?? 'opencode';
      const normalizedCommand = command === null
        ? null
        : command !== undefined
          ? normalizeRuntimeCommandId(command, runtimeForCommand)
          : undefined;
      board.cards[index] = {
        ...board.cards[index],
        ...safeUpdates,
        updatedAt: now,
      };
      if (completedAt === null) {
        delete board.cards[index].completedAt;
      } else if (completedAt !== undefined) {
        board.cards[index].completedAt = completedAt;
      }
      if (responseAt === null) {
        delete board.cards[index].responseAt;
      } else if (responseAt !== undefined) {
        board.cards[index].responseAt = responseAt;
      }
      if (startedAt === null) {
        delete board.cards[index].startedAt;
      } else if (startedAt !== undefined) {
        board.cards[index].startedAt = startedAt;
      }
      if (durationMs === null) {
        delete board.cards[index].durationMs;
      } else if (durationMs !== undefined) {
        board.cards[index].durationMs = durationMs;
      }
      if (completedSeenAt === null) {
        delete board.cards[index].completedSeenAt;
      } else if (completedSeenAt !== undefined) {
        board.cards[index].completedSeenAt = completedSeenAt;
      }
      // Auto-stamp startedAt the first time a card enters in_progress
      if (safeUpdates.status === 'in_progress' && !board.cards[index].startedAt && startedAt === undefined) {
        board.cards[index].startedAt = now;
      }
      if (safeUpdates.status === 'complete' && previousStatus !== 'complete' && completedAt === undefined) {
        board.cards[index].completedAt = now;
      }
      // Auto-compute durationMs on completion when we know when work started
      if (
        durationMs === undefined &&
        board.cards[index].status === 'complete' &&
        previousStatus !== 'complete' &&
        board.cards[index].startedAt
      ) {
        const start = new Date(board.cards[index].startedAt as string).getTime();
        const end = new Date(board.cards[index].completedAt ?? now).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          board.cards[index].durationMs = end - start;
        }
      }
      if (safeUpdates.status === 'done' && completedSeenAt === undefined) {
        board.cards[index].completedSeenAt = now;
      }
      if (scheduledDispatch === null) {
        delete board.cards[index].scheduledDispatch;
      } else if (scheduledDispatch !== undefined) {
        const normalizedScheduledDispatch = normalizeScheduledDispatchState(scheduledDispatch);
        if (!normalizedScheduledDispatch) {
          throw new Error('Invalid scheduled dispatch payload');
        }
        board.cards[index].scheduledDispatch = normalizedScheduledDispatch;
      }
      // Handle queue field updates: null → delete, value → set
      if (queuedAfterCardId === null) {
        delete board.cards[index].queuedAfterCardId;
      } else if (queuedAfterCardId !== undefined) {
        board.cards[index].queuedAfterCardId = queuedAfterCardId;
      }
      if (queuePosition === null) {
        delete board.cards[index].queuePosition;
      } else if (queuePosition !== undefined) {
        board.cards[index].queuePosition = queuePosition;
      }
      if (queueSessionMode === null) {
        delete board.cards[index].queueSessionMode;
      } else if (queueSessionMode !== undefined) {
        board.cards[index].queueSessionMode = queueSessionMode;
      }
      // Handle stale field updates: null → delete, value → set
      if (staleStatus === null) {
        delete board.cards[index].staleStatus;
      } else if (staleStatus !== undefined) {
        board.cards[index].staleStatus = staleStatus;
      }
      if (staleDetectedAt === null) {
        delete board.cards[index].staleDetectedAt;
      } else if (staleDetectedAt !== undefined) {
        board.cards[index].staleDetectedAt = staleDetectedAt;
      }
      if (model === null) {
        delete board.cards[index].model;
      } else if (model !== undefined) {
        board.cards[index].model = model;
      }
      if (agentRuntime !== undefined) {
        board.cards[index].agentRuntime = agentRuntime;
      }
      if (agentType === null) {
        delete board.cards[index].agentType;
      } else if (agentType !== undefined) {
        board.cards[index].agentType = agentType;
      }
      if (normalizedCommand === null) {
        delete board.cards[index].command;
      } else if (normalizedCommand !== undefined) {
        board.cards[index].command = normalizedCommand;
      } else if (command !== undefined) {
        delete board.cards[index].command;
        delete board.cards[index].arguments;
      } else if (agentRuntime !== undefined && board.cards[index].command) {
        const commandStillValid = normalizeRuntimeCommandId(board.cards[index].command, agentRuntime);
        if (!commandStillValid) {
          delete board.cards[index].command;
          delete board.cards[index].arguments;
        }
      }
      if (commandArguments === null) {
        delete board.cards[index].arguments;
      } else if (commandArguments !== undefined) {
        board.cards[index].arguments = commandArguments;
      }
      if (codexOptions === null) {
        delete board.cards[index].codexOptions;
      } else if (codexOptions !== undefined) {
        board.cards[index].codexOptions = codexOptions;
      }
      if (claudeOptions === null) {
        delete board.cards[index].claudeOptions;
      } else if (claudeOptions !== undefined) {
        board.cards[index].claudeOptions = claudeOptions;
      }
      if (resumeSessionId === null) {
        delete board.cards[index].resumeSessionId;
      } else if (resumeSessionId !== undefined) {
        board.cards[index].resumeSessionId = resumeSessionId;
      }
      if (resolution === null) {
        delete board.cards[index].resolution;
      } else if (resolution !== undefined) {
        board.cards[index].resolution = resolution;
      }
      if (supersededByCardId === null) {
        delete board.cards[index].supersededByCardId;
      } else if (supersededByCardId !== undefined) {
        board.cards[index].supersededByCardId = supersededByCardId;
      }
      if (supersededAt === null) {
        delete board.cards[index].supersededAt;
      } else if (supersededAt !== undefined) {
        board.cards[index].supersededAt = supersededAt;
      }
      if (originChannel === null) {
        delete board.cards[index].originChannel;
      } else if (originChannel !== undefined) {
        board.cards[index].originChannel = originChannel;
      }
      if (schedulerId === null) {
        delete board.cards[index].schedulerId;
      } else if (schedulerId !== undefined) {
        board.cards[index].schedulerId = schedulerId;
      }
      if (schedulerRunId === null) {
        delete board.cards[index].schedulerRunId;
      } else if (schedulerRunId !== undefined) {
        board.cards[index].schedulerRunId = schedulerRunId;
      }
      if (schedulerName === null) {
        delete board.cards[index].schedulerName;
      } else if (schedulerName !== undefined) {
        board.cards[index].schedulerName = schedulerName;
      }
      if (telegramMessageId === null) {
        delete board.cards[index].telegramMessageId;
      } else if (telegramMessageId !== undefined) {
        board.cards[index].telegramMessageId = telegramMessageId;
      }
      if (telegramReplyStatus === null) {
        delete board.cards[index].telegramReplyStatus;
      } else if (telegramReplyStatus !== undefined) {
        board.cards[index].telegramReplyStatus = telegramReplyStatus;
      }
      if (telegramReplyMessageId === null) {
        delete board.cards[index].telegramReplyMessageId;
      } else if (telegramReplyMessageId !== undefined) {
        board.cards[index].telegramReplyMessageId = telegramReplyMessageId;
      }
      if (telegramReplyError === null) {
        delete board.cards[index].telegramReplyError;
      } else if (telegramReplyError !== undefined) {
        board.cards[index].telegramReplyError = telegramReplyError;
      }
      if (telegramReplyUpdatedAt === null) {
        delete board.cards[index].telegramReplyUpdatedAt;
      } else if (telegramReplyUpdatedAt !== undefined) {
        board.cards[index].telegramReplyUpdatedAt = telegramReplyUpdatedAt;
      }
      if (
        queuedAfterCardId !== undefined
        || queuePosition !== undefined
        || queueSessionMode !== undefined
      ) {
        validateQueueCompatibility(board.cards[index]);
      }
      const allowScheduledDispatchStatusTransition = safeUpdates.status === 'in_progress'
        || scheduledDispatch !== undefined;
      if (hasActiveScheduledDispatch(board.cards[index]) && !allowScheduledDispatchStatusTransition) {
        validateCardScheduleEligibility(board.cards[index]);
      }
      board.lastModified = now;
      await this.save(board);
      updatedCard = board.cards[index];
    });

    return updatedCard!;
  }

  async scheduleCardDispatch(id: string, scheduledAt: string): Promise<KanbanCard> {
    const now = new Date().toISOString();
    let updatedCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const card = board.cards.find((entry) => entry.id === id);
      if (!card) {
        throw new Error(`Card not found: ${id}`);
      }

      validateCardScheduleEligibility(card);
      card.scheduledDispatch = createScheduledDispatchState(scheduledAt, now);
      card.updatedAt = now;
      board.lastModified = now;
      await this.save(board);
      updatedCard = card;
    });

    return updatedCard!;
  }

  async cancelScheduledDispatch(id: string): Promise<KanbanCard> {
    const now = new Date().toISOString();
    let updatedCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const card = board.cards.find((entry) => entry.id === id);
      if (!card) {
        throw new Error(`Card not found: ${id}`);
      }

      delete card.scheduledDispatch;
      card.updatedAt = now;
      board.lastModified = now;
      await this.save(board);
      updatedCard = card;
    });

    return updatedCard!;
  }

  async claimScheduledDispatch(id: string, claimAt = new Date().toISOString()): Promise<KanbanCard | null> {
    let claimedCard: KanbanCard | null = null;

    await this.withDualLock(async () => {
      const board = await this.load();
      const card = board.cards.find((entry) => entry.id === id);
      if (!card) {
        throw new Error(`Card not found: ${id}`);
      }
      if (!card.scheduledDispatch || card.scheduledDispatch.status !== 'scheduled') {
        return;
      }

      validateCardScheduleEligibility(card);
      card.scheduledDispatch = claimScheduledDispatchState(card.scheduledDispatch, claimAt);
      card.updatedAt = claimAt;
      board.lastModified = claimAt;
      await this.save(board);
      claimedCard = card;
    });

    return claimedCard;
  }

  async claimDueScheduledDispatch(dueAt = new Date().toISOString()): Promise<KanbanCard[]> {
    const claimedCards: KanbanCard[] = [];

    await this.withDualLock(async () => {
      const board = await this.load();
      const dueCards = board.cards
        .filter((card) =>
          card.scheduledDispatch?.status === 'scheduled'
          && card.scheduledDispatch.scheduledAt <= dueAt,
        )
        .sort((a, b) => a.scheduledDispatch!.scheduledAt.localeCompare(b.scheduledDispatch!.scheduledAt));

      for (const card of dueCards) {
        validateCardScheduleEligibility(card);
        card.scheduledDispatch = claimScheduledDispatchState(card.scheduledDispatch!, dueAt);
        card.updatedAt = dueAt;
        claimedCards.push(card);
      }

      if (claimedCards.length > 0) {
        board.lastModified = dueAt;
        await this.save(board);
      }
    });

    return claimedCards;
  }

  async recoverStaleScheduledDispatchClaims(
    staleBefore: string,
    recoveredAt = new Date().toISOString(),
  ): Promise<KanbanCard[]> {
    const recoveredCards: KanbanCard[] = [];

    await this.withDualLock(async () => {
      const board = await this.load();
      for (const card of board.cards) {
        if (
          card.scheduledDispatch?.status !== 'dispatching'
          || card.scheduledDispatch.updatedAt > staleBefore
        ) {
          continue;
        }

        validateCardScheduleEligibility(card);
        card.scheduledDispatch = recoverScheduledDispatchClaimState(card.scheduledDispatch, recoveredAt);
        card.updatedAt = recoveredAt;
        recoveredCards.push(card);
      }

      if (recoveredCards.length > 0) {
        board.lastModified = recoveredAt;
        await this.save(board);
      }
    });

    return recoveredCards;
  }

  async finalizeScheduledDispatch(
    id: string,
    result: { status: 'dispatched' | 'failed'; dispatchedAt?: string; error?: string },
    updatedAt = new Date().toISOString(),
  ): Promise<KanbanCard> {
    let updatedCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const card = board.cards.find((entry) => entry.id === id);
      if (!card) {
        throw new Error(`Card not found: ${id}`);
      }
      if (!card.scheduledDispatch) {
        throw new Error(`Card has no scheduled dispatch: ${id}`);
      }

      card.scheduledDispatch = finalizeScheduledDispatchState(card.scheduledDispatch, updatedAt, result);
      card.updatedAt = updatedAt;
      board.lastModified = updatedAt;
      await this.save(board);
      updatedCard = card;
    });

    return updatedCard!;
  }

  async markCompletionSeen(id: string): Promise<KanbanCard> {
    const now = new Date().toISOString();
    let updatedCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const index = board.cards.findIndex(c => c.id === id);
      if (index === -1) {
        throw new Error(`Card not found: ${id}`);
      }

      const card = board.cards[index];
      if (card.status !== 'complete') {
        throw new Error(`Card is not complete: ${id}`);
      }

      if (!card.completedAt) {
        card.completedAt = card.updatedAt;
      }
      card.completedSeenAt = now;
      board.lastModified = now;
      await this.save(board);
      updatedCard = card;
    });

    return updatedCard!;
  }

  async deleteCard(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const board = await this.load();
      const now = new Date().toISOString();
      const target = board.cards.find(c => c.id === id && isActiveCard(c));
      if (!target) return;

      // Cascade clear: remove queue references to the deleted card
      for (const card of board.cards) {
        if (card.queuedAfterCardId === id) {
          card.queuedAfterCardId = undefined;
          card.queuePosition = undefined;
          card.queueSessionMode = undefined;
          card.updatedAt = now;
        }
      }

      target.deletedAt = now;
      target.updatedAt = now;
      board.lastModified = now;
      await this.save(board);
    });
  }

  /**
   * Soft-delete many active board cards in a single locked pass (one save).
   * Used to clean up bulk noise (e.g. wiki-internal cards). Returns the count
   * actually marked. Archived cards are not touched.
   */
  async softDeleteCards(ids: string[]): Promise<number> {
    const idSet = new Set(ids);
    if (idSet.size === 0) return 0;
    let deleted = 0;
    await this.withDualLock(async () => {
      const board = await this.load();
      const now = new Date().toISOString();
      for (const card of board.cards) {
        if (idSet.has(card.id) && isActiveCard(card)) {
          card.deletedAt = now;
          card.updatedAt = now;
          deleted++;
        }
      }
      if (deleted > 0) {
        board.lastModified = now;
        await this.save(board);
      }
    });
    return deleted;
  }

  async getCard(id: string, options?: { includeDeleted?: boolean }): Promise<KanbanCard | null> {
    const board = await this.load();
    const card = board.cards.find(c => c.id === id) ?? null;
    if (!card) return null;
    if (card.deletedAt && !options?.includeDeleted) return null;
    return card;
  }

  async getDeletedCards(): Promise<KanbanCard[]> {
    const board = await this.load();
    return board.cards
      .filter((card) => !!card.deletedAt)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  async restoreCard(id: string): Promise<KanbanCard> {
    let restoredCard: KanbanCard | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const index = board.cards.findIndex(c => c.id === id && !!c.deletedAt);
      if (index === -1) {
        throw new Error(`Deleted card not found: ${id}`);
      }

      const now = new Date().toISOString();
      delete board.cards[index].deletedAt;
      board.cards[index].updatedAt = now;
      board.lastModified = now;
      await this.save(board);
      restoredCard = board.cards[index];
    });

    return restoredCard!;
  }

  /**
   * Permanently remove soft-deleted cards from the active board (one locked
   * pass, one save). Soft delete only sets `deletedAt`; nothing else ever drops
   * those rows from `active.json` (only `archiveCards` mutates `board.cards`,
   * and it skips soft-deleted cards), so they accumulate forever. This compacts
   * them out. Irreversible — restore is impossible once purged. Returns the
   * number of cards removed.
   */
  async purgeDeletedCards(): Promise<number> {
    let purged = 0;
    await this.withDualLock(async () => {
      const board = await this.load();
      const before = board.cards.length;
      board.cards = board.cards.filter((card) => !card.deletedAt);
      purged = before - board.cards.length;
      if (purged > 0) {
        board.lastModified = new Date().toISOString();
        await this.save(board);
      }
    });
    return purged;
  }

  /**
   * Get cards queued after a specific card, sorted by queue position.
   */
  async getQueuedCards(afterCardId: string): Promise<KanbanCard[]> {
    const board = await this.load();
    return board.cards
      .filter(c => isActiveCard(c) && c.queuedAfterCardId === afterCardId)
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  }

  /**
   * Calculate the next queue position number for a card.
   */
  async getNextQueuePosition(afterCardId: string): Promise<number> {
    const queued = await this.getQueuedCards(afterCardId);
    if (queued.length === 0) return 1;
    return Math.max(...queued.map(c => c.queuePosition ?? 0)) + 1;
  }


  async findCardBySessionId(sessionId: string): Promise<KanbanCard | null> {
    const board = await this.load();
    // Exclude linkKind=nested cards: they are child sessions, not session representatives.
    const matches = board.cards.filter(
      c => isActiveCard(c) && c.sessionId === sessionId && c.linkKind !== 'nested',
    );
    if (matches.length === 0) return null;
    // Prefer top-level cards (no parentCardId). If only child cards exist, fall back to them.
    const topLevel = matches.filter(c => !c.parentCardId);
    const candidates = topLevel.length > 0 ? topLevel : matches;
    // Return the most recently created among the candidates.
    return candidates.reduce((latest, c) =>
      c.createdAt > latest.createdAt ? c : latest
    );
  }

  async findByChildLink(parentCardId: string, runId: string, childTaskId: string): Promise<KanbanCard | null> {
    const board = await this.load();
    return board.cards.find(
      c => isActiveCard(c) &&
        c.parentCardId === parentCardId &&
        c.childRunId === runId &&
        c.childTaskId === childTaskId,
    ) ?? null;
  }

  async getCards(filter?: { status?: KanbanStatus; includeArchived?: boolean; includeDeleted?: boolean }): Promise<KanbanCard[]> {
    const board = await this.load();
    let cards = filter?.includeDeleted ? board.cards : board.cards.filter(isActiveCard);

    if (filter?.includeArchived) {
      const archived = await this.loadArchives();
      cards = [
        ...cards,
        ...(filter.includeDeleted ? archived : archived.filter(isActiveCard)),
      ];
    }

    if (filter?.status) {
      return cards.filter(c => c.status === filter.status);
    }
    return cards;
  }

  async archiveCards(cardIds?: string[]): Promise<{ archivedCount: number; archiveMonth: string }> {
    let archivedCount = 0;
    let primaryMonth = '';

    await this.withDualLock(async () => {
      const board = await this.load();

      // Determine which cards to archive
      let toArchive: KanbanCard[];
      if (cardIds && cardIds.length > 0) {
        const requestedIds = new Set(cardIds);
        const requestedDoneCards = board.cards.filter(
          (card) => requestedIds.has(card.id) && card.status === 'done',
        );
        const requestedParentIds = new Set(
          requestedDoneCards
            .filter((card) => !card.parentCardId)
            .map((card) => card.id),
        );

        toArchive = board.cards.filter((card) => {
          if (isActiveCard(card) && requestedIds.has(card.id) && card.status === 'done') {
            return true;
          }

          return isActiveCard(card)
            && !!card.parentCardId
            && requestedParentIds.has(card.parentCardId)
            && card.status === 'done'
            && !card.favorite;
        });
      } else {
        toArchive = board.cards.filter(c => isActiveCard(c) && c.status === 'done');
      }

      if (toArchive.length === 0) {
        return;
      }

      // Stamp wiki processing queue state at archive time. Child cards are
      // archived for traceability but excluded from the wiki pipeline.
      const wikiQueuedAt = new Date().toISOString();
      for (const card of toArchive) {
        if (!isWikiEligibleCard(card)) {
          delete card.wiki;
          continue;
        }
        if (!card.wiki) {
          card.wiki = { status: 'pending', queuedAt: wikiQueuedAt };
        }
      }

      // Group by month using updatedAt
      const byMonth = new Map<string, KanbanCard[]>();
      for (const card of toArchive) {
        const month = card.updatedAt.slice(0, 7); // "YYYY-MM"
        const group = byMonth.get(month);
        if (group) {
          group.push(card);
        } else {
          byMonth.set(month, [card]);
        }
      }

      // Ensure archive dir exists
      if (!existsSync(this.archiveDir)) {
        mkdirSync(this.archiveDir, { recursive: true });
      }

      // Write each month's archive
      for (const [month, cards] of byMonth) {
        const archivePath = join(this.archiveDir, `${month}.json`);
        const tmpArchivePath = join(this.archiveDir, `.${month}.json.tmp`);

        let archive: KanbanArchive;
        if (existsSync(archivePath)) {
          const content = await Bun.file(archivePath).text();
          archive = JSON.parse(content) as KanbanArchive;
          archive.cards.push(...cards);
          archive.archivedAt = new Date().toISOString();
        } else {
          archive = {
            month,
            cards,
            archivedAt: new Date().toISOString(),
          };
        }

        // Atomic write for archive file
        await Bun.write(tmpArchivePath, JSON.stringify(archive, null, 2));
        renameSync(tmpArchivePath, archivePath);
      }

      // Remove archived cards from active board
      const archivedIds = new Set(toArchive.map(c => c.id));
      board.cards = board.cards.filter(c => !archivedIds.has(c.id));
      board.lastModified = new Date().toISOString();
      await this.save(board);

      archivedCount = toArchive.length;
      // Primary month = most common month among archived cards
      let maxCount = 0;
      for (const [month, cards] of byMonth) {
        if (cards.length > maxCount) {
          maxCount = cards.length;
          primaryMonth = month;
        }
      }
    });

    return { archivedCount, archiveMonth: primaryMonth };
  }

  async loadArchives(): Promise<KanbanCard[]> {
    if (!existsSync(this.archiveDir)) {
      return [];
    }

    const files = readdirSync(this.archiveDir).filter(f => extname(f) === '.json');
    const allCards: KanbanCard[] = [];

    for (const file of files) {
      const filePath = join(this.archiveDir, file);
      const content = await Bun.file(filePath).text();
      const archive = JSON.parse(content) as KanbanArchive;
      allCards.push(...archive.cards.map(migrateCardStatus));
    }

    // Sort by updatedAt descending
    allCards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return allCards;
  }

  // ─── Wiki Archive Methods ────────────────────────────────────────

  /** List archive months ("YYYY-MM"), most recent first. */
  listArchiveMonths(): string[] {
    if (!existsSync(this.archiveDir)) {
      return [];
    }
    return readdirSync(this.archiveDir)
      .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 7))
      .sort((a, b) => b.localeCompare(a));
  }

  /** Load a single month's archive, or null if it doesn't exist. */
  async loadArchiveMonth(month: string): Promise<KanbanArchive | null> {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return null;
    }
    const archivePath = join(this.archiveDir, `${month}.json`);
    if (!existsSync(archivePath)) {
      return null;
    }
    const content = await Bun.file(archivePath).text();
    const archive = JSON.parse(content) as KanbanArchive;
    return { ...archive, cards: archive.cards.map(migrateCardStatus) };
  }

  async loadWikiArchiveMonth(month: string): Promise<KanbanArchive | null> {
    const archive = await this.loadArchiveMonth(month);
    if (!archive) return null;
    return { ...archive, cards: archive.cards.filter(isWikiEligibleCard) };
  }

  async listWikiArchiveCards(query: WikiArchiveCardsQuery = {}): Promise<WikiArchiveCardsResponse> {
    const requestedLimit = query.limit !== undefined && Number.isFinite(query.limit) ? query.limit : 100;
    const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 200));
    const status = query.status ?? 'all';
    const normalizedQuery = query.q?.trim().toLowerCase() ?? '';
    const months = this.listArchiveMonths();
    const cursor = query.cursor ? decodeWikiArchiveCursor(query.cursor) : null;
    const startMonthIndex = cursor
      ? Math.max(0, months.indexOf(cursor.month))
      : 0;
    const cards: KanbanCard[] = [];
    let nextCursor: string | null = null;

    for (let monthIndex = startMonthIndex; monthIndex < months.length; monthIndex++) {
      const month = months[monthIndex];
      const archive = await this.loadArchiveMonth(month);
      const monthCards = (archive?.cards ?? [])
        .filter(isWikiEligibleCard)
        .filter((card) => matchesWikiArchiveStatus(card, status))
        .filter((card) => matchesWikiArchiveSearch(card, normalizedQuery))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      const offset = cursor && month === cursor.month ? cursor.offset : 0;
      if (offset >= monthCards.length) {
        continue;
      }

      const remaining = limit - cards.length;
      const page = monthCards.slice(offset, offset + remaining);
      cards.push(...page);

      if (cards.length >= limit) {
        const nextOffset = offset + page.length;
        if (nextOffset < monthCards.length) {
          nextCursor = encodeWikiArchiveCursor({ v: 1, month, offset: nextOffset });
        } else if (monthIndex + 1 < months.length) {
          nextCursor = encodeWikiArchiveCursor({ v: 1, month: months[monthIndex + 1], offset: 0 });
        }
        break;
      }
    }

    return { cards, nextCursor };
  }

  /** Archived cards whose wiki processing is still pending (soft-deleted excluded). */
  async getWikiPendingCards(): Promise<KanbanCard[]> {
    const archived = await this.loadArchives();
    return archived.filter(c => isWikiEligibleCard(c) && c.wiki?.status === 'pending');
  }

  /**
   * Aggregate wiki processing counts across the whole archive in one pass.
   * `byType`/`docCount` count unique documents (cards collapse into shared
   * session docs), while kept/skipped/failed/pending count cards.
   */
  async getWikiStats(): Promise<WikiStats> {
    const archived = await this.loadArchives();
    const byType: Record<WikiDocType, number> = {
      troubleshooting: 0, howto: 0, decision: 0, concept: 0, reference: 0,
    };
    const seenDocs = new Set<string>();
    let total = 0, kept = 0, skipped = 0, failed = 0, pending = 0, unprocessed = 0;

    for (const card of archived) {
      if (!isWikiEligibleCard(card)) continue;
      total++;
      const wiki = card.wiki;
      if (!wiki) { unprocessed++; continue; }
      if (wiki.status === 'pending') { pending++; continue; }
      if (wiki.status === 'failed') { failed++; continue; }
      if (wiki.decision === 'skipped') { skipped++; continue; }
      if (wiki.decision === 'kept') {
        kept++;
        if (wiki.docType && wiki.docPath && !seenDocs.has(wiki.docPath)) {
          seenDocs.add(wiki.docPath);
          byType[wiki.docType]++;
        }
      }
    }

    return { total, kept, skipped, failed, pending, unprocessed, docCount: seenDocs.size, byType };
  }

  /**
   * Apply wiki state updates to archived cards in one pass per archive file.
   * Returns the number of cards updated.
   */
  async updateArchivedCardsWiki(updates: Record<string, CardWikiState>): Promise<number> {
    const ids = new Set(Object.keys(updates));
    if (ids.size === 0) {
      return 0;
    }
    let updatedCount = 0;

    await this.withDualLock(async () => {
      for (const month of this.listArchiveMonths()) {
        const archivePath = join(this.archiveDir, `${month}.json`);
        const content = await Bun.file(archivePath).text();
        const archive = JSON.parse(content) as KanbanArchive;
        let changed = false;
        for (const card of archive.cards) {
          if (ids.has(card.id)) {
            card.wiki = updates[card.id];
            changed = true;
            updatedCount++;
          }
        }
        if (changed) {
          const tmpPath = join(this.archiveDir, `.${month}.json.tmp`);
          await Bun.write(tmpPath, JSON.stringify(archive, null, 2));
          renameSync(tmpPath, archivePath);
        }
      }
    });

    return updatedCount;
  }

  /**
   * Mark archived cards as wiki-pending (backfill / reprocess).
   * - cardIds given → force re-queue exactly those cards.
   * - otherwise → queue cards with no wiki state, a failed state, or a
   *   promptVersion older than currentPromptVersion.
   * - limit → cap the queue at the N most recently updated candidates
   *   (token-spend guard for large archives).
   * Returns the number of cards queued.
   */
  async markWikiPending(opts: { currentPromptVersion: number; cardIds?: string[]; limit?: number }): Promise<number> {
    let requestedIds = opts.cardIds && opts.cardIds.length > 0 ? new Set(opts.cardIds) : null;
    if (!requestedIds && opts.limit && opts.limit > 0) {
      // loadArchives() returns cards sorted by updatedAt desc → newest first.
      const archived = await this.loadArchives();
      const candidates = archived.filter(card =>
        isWikiEligibleCard(card)
        && card.wiki?.status !== 'pending'
        && (
          !card.wiki
          || card.wiki.status === 'failed'
          || (card.wiki.promptVersion ?? 0) < opts.currentPromptVersion
        ),
      );
      requestedIds = new Set(candidates.slice(0, opts.limit).map(card => card.id));
    }
    const now = new Date().toISOString();
    let queued = 0;

    await this.withDualLock(async () => {
      for (const month of this.listArchiveMonths()) {
        const archivePath = join(this.archiveDir, `${month}.json`);
        const content = await Bun.file(archivePath).text();
        const archive = JSON.parse(content) as KanbanArchive;
        let changed = false;
        for (const card of archive.cards) {
          if (!isWikiEligibleCard(card)) continue;
          if (card.wiki?.status === 'pending') continue;
          const needsQueue = requestedIds
            ? requestedIds.has(card.id)
            : !card.wiki
              || card.wiki.status === 'failed'
              || (card.wiki.promptVersion ?? 0) < opts.currentPromptVersion;
          if (!needsQueue) continue;
          // Keep prior classification (docPath etc.) so reprocessing can overwrite in place.
          const { error: _error, ...rest } = card.wiki ?? {};
          card.wiki = { ...rest, status: 'pending', queuedAt: now };
          changed = true;
          queued++;
        }
        if (changed) {
          const tmpPath = join(this.archiveDir, `.${month}.json.tmp`);
          await Bun.write(tmpPath, JSON.stringify(archive, null, 2));
          renameSync(tmpPath, archivePath);
        }
      }
    });

    return queued;
  }

  /**
   * Undo pending wiki stamps (e.g. after over-queueing a huge backfill).
   * Never-processed pending cards lose their wiki state entirely; re-queued
   * cards that carry a previous decision revert to 'processed'.
   * Returns the number of cards unqueued.
   */
  async unqueueWikiPending(): Promise<number> {
    let unqueued = 0;

    await this.withDualLock(async () => {
      for (const month of this.listArchiveMonths()) {
        const archivePath = join(this.archiveDir, `${month}.json`);
        const content = await Bun.file(archivePath).text();
        const archive = JSON.parse(content) as KanbanArchive;
        let changed = false;
        for (const card of archive.cards) {
          if (card.wiki?.status !== 'pending') continue;
          if (card.wiki.decision) {
            card.wiki = { ...card.wiki, status: 'processed' };
          } else {
            delete card.wiki;
          }
          changed = true;
          unqueued++;
        }
        if (changed) {
          const tmpPath = join(this.archiveDir, `.${month}.json.tmp`);
          await Bun.write(tmpPath, JSON.stringify(archive, null, 2));
          renameSync(tmpPath, archivePath);
        }
      }
    });

    return unqueued;
  }

  // ─── Screenshot Methods ──────────────────────────────────────────

  private ensureScreenshotDir(): void {
    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  /**
   * Save a screenshot file and attach metadata to a card.
   */
  async saveScreenshot(cardId: string, fileData: ArrayBuffer, originalName: string, mimeType: string): Promise<Screenshot> {
    this.ensureScreenshotDir();

    const id = nanoid();
    const timestamp = Date.now();
    const ext = extname(originalName) || '.png';
    const filename = `${cardId}_${timestamp}_${id}${ext}`;
    const filePath = join(this.screenshotDir, filename);

    // Write file to disk
    await Bun.write(filePath, fileData);

    const screenshot: Screenshot = {
      id,
      cardId,
      filename,
      originalName,
      mimeType,
      size: fileData.byteLength,
      createdAt: new Date().toISOString(),
    };

    // Attach to card within dual lock
    await this.withDualLock(async () => {
      const board = await this.load();
      const index = board.cards.findIndex(c => c.id === cardId);
      if (index === -1) {
        // Clean up the written file since card doesn't exist
        try { unlinkSync(filePath); } catch { /* ignore */ }
        throw new Error(`Card not found: ${cardId}`);
      }
      const card = board.cards[index];
      card.screenshots = card.screenshots ?? [];
      card.screenshots.push(screenshot);
      card.updatedAt = new Date().toISOString();
      board.lastModified = card.updatedAt;
      await this.save(board);
    });

    return screenshot;
  }

  /**
   * Delete a screenshot file and remove metadata from card.
   */
  async deleteScreenshot(cardId: string, screenshotId: string): Promise<void> {
    let filename: string | undefined;

    await this.withDualLock(async () => {
      const board = await this.load();
      const cardIndex = board.cards.findIndex(c => c.id === cardId);
      if (cardIndex === -1) throw new Error(`Card not found: ${cardId}`);

      const card = board.cards[cardIndex];
      const ssIndex = (card.screenshots ?? []).findIndex(s => s.id === screenshotId);
      if (ssIndex === -1) throw new Error(`Screenshot not found: ${screenshotId}`);

      filename = card.screenshots![ssIndex].filename;
      card.screenshots!.splice(ssIndex, 1);
      if (card.screenshots!.length === 0) {
        delete card.screenshots;
      }
      card.updatedAt = new Date().toISOString();
      board.lastModified = card.updatedAt;
      await this.save(board);
    });

    // Delete file from disk (outside lock)
    if (filename) {
      const filePath = join(this.screenshotDir, filename);
      try { unlinkSync(filePath); } catch { /* file may already be gone */ }
    }
  }

  /**
   * Get the filesystem path for a screenshot file.
   */
  getScreenshotPath(filename: string): string {
    return join(this.screenshotDir, filename);
  }

  private defaultBoard(): KanbanBoard {
    return {
      version: 1,
      cards: [],
      lastModified: new Date().toISOString(),
    };
  }
}
