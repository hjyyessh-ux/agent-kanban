import type { KanbanCard, UpdateCardInput } from '../../../src/core/types';

/**
 * Merge a partial card update into an existing card the same way the board
 * API does: `undefined` leaves a field untouched, `null` deletes the
 * optional field, and a concrete value replaces it.
 */
export function applyCardUpdates(card: KanbanCard, updates: UpdateCardInput): KanbanCard {
  const {
    title,
    description,
    projectDir,
    model,
    agentRuntime,
    agentType,
    codexOptions,
    claudeOptions,
    queueSessionMode,
    resumeSessionId,
    command,
    arguments: commandArguments,
    favorite,
  } = updates;

  const nextCard: KanbanCard = {
    ...card,
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(projectDir !== undefined && { projectDir }),
    ...(agentRuntime !== undefined && { agentRuntime }),
    ...(favorite !== undefined && { favorite }),
  };

  if (model === null) delete nextCard.model;
  else if (model !== undefined) nextCard.model = model;

  if (agentType === null) delete nextCard.agentType;
  else if (agentType !== undefined) nextCard.agentType = agentType;

  if (codexOptions === null) delete nextCard.codexOptions;
  else if (codexOptions !== undefined) nextCard.codexOptions = codexOptions;

  if (claudeOptions === null) delete nextCard.claudeOptions;
  else if (claudeOptions !== undefined) nextCard.claudeOptions = claudeOptions;

  if (queueSessionMode === null) delete nextCard.queueSessionMode;
  else if (queueSessionMode !== undefined) nextCard.queueSessionMode = queueSessionMode;

  if (resumeSessionId === null) delete nextCard.resumeSessionId;
  else if (resumeSessionId !== undefined) nextCard.resumeSessionId = resumeSessionId;

  if (command === null) delete nextCard.command;
  else if (command !== undefined) nextCard.command = command;

  if (commandArguments === null) delete nextCard.arguments;
  else if (commandArguments !== undefined) nextCard.arguments = commandArguments;

  return nextCard;
}
