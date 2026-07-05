import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getKanbanDataDir } from './config';

function resolveDebugLogFile(): string {
  return process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE ?? join(getKanbanDataDir(), 'runtime-debug.log');
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export function appendRuntimeDebugLog(event: string, payload?: Record<string, unknown>): void {
  try {
    mkdirSync(getKanbanDataDir(), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(payload ?? {}),
    };
    appendFileSync(resolveDebugLogFile(), `${safeSerialize(record)}\n`);
  } catch {
  }
}

export function getRuntimeDebugLogPath(): string {
  return resolveDebugLogFile();
}
