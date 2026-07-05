import type { KanbanCard, Screenshot } from '../core/types';
import { getCodexSkillName, getRuntimeCommandDefinition } from '../core/commands';
import { resolveAgentRuntime } from '../core/runtime-config';

type ScreenshotResolver = (screenshot: Screenshot) => string;

export function buildDispatchPromptText(
  card: Pick<KanbanCard, 'description' | 'screenshots'> & Partial<Pick<KanbanCard, 'agentRuntime' | 'command' | 'arguments'>>,
  resolveScreenshotPath: ScreenshotResolver,
): string {
  const runtime = resolveAgentRuntime(card);
  const description = withRuntimeCommandContext(card, runtime);
  const screenshots = card.screenshots ?? [];

  if (screenshots.length === 0) {
    return description;
  }

  const lines = [
    description,
    '',
    'Attached screenshots:',
    ...screenshots.map((screenshot, index) => [
      `${index + 1}. ${screenshot.originalName ?? screenshot.filename}`,
      `   - path: ${resolveScreenshotPath(screenshot)}`,
      `   - mimeType: ${screenshot.mimeType}`,
      `   - size: ${screenshot.size} bytes`,
    ].join('\n')),
    '',
    'Use the screenshot file path(s) above as visual context for this task.',
  ];

  return lines.filter((line, index) => index === 0 || line.length > 0 || description.length > 0).join('\n');
}

function withRuntimeCommandContext(
  card: Pick<KanbanCard, 'description'> & Partial<Pick<KanbanCard, 'agentRuntime' | 'command' | 'arguments'>>,
  runtime: ReturnType<typeof resolveAgentRuntime>,
): string {
  const description = card.description.trim();
  if (runtime === 'opencode') return description;

  const definition = getRuntimeCommandDefinition(card.command, runtime);
  if (!definition) return description;

  const skillName = runtime === 'codex' ? getCodexSkillName(card.command) : undefined;
  const commandToken = skillName ? `$${skillName}` : `/${card.command}`;
  const commandLine = [commandToken, card.arguments?.trim()].filter(Boolean).join(' ');

  // Claude commands are real slash commands. Prepend them so the prompt piped
  // to `claude -p` executes the command; `command_only` commands ignore the
  // card description entirely.
  if (runtime === 'claude') {
    if (definition.executionMode === 'command_only') return commandLine;
    return description ? `${commandLine}\n\n${description}` : commandLine;
  }

  if (skillName) {
    return description ? `${commandLine}\n\n${description}` : commandLine;
  }

  // Codex prompt presets are not executable slash commands, so describe the
  // selected command as additional context for the run.
  const lines = [
    `Codex command: ${commandLine}`,
    `Command purpose: ${definition.description}`,
    '',
    description,
  ];

  return lines.filter((line, index) => index < 3 || line.length > 0 || description.length > 0).join('\n');
}
