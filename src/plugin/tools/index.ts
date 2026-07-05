import type { KanbanStore } from '../../core/store';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SettingsStore } from '../../core/settings-store';
import type { SchedulerEngine } from '../scheduler-engine';
import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';

export { createKanbanCreateTool } from './kanban_create';
export { createKanbanListTool } from './kanban_list';
export { createKanbanGetTool } from './kanban_get';
export { createKanbanUpdateTool } from './kanban_update';
export { createKanbanDeleteTool } from './kanban_delete';
export { createKanbanArchiveTool } from './kanban_archive';
export { createSchedulerCreateTool } from './scheduler_create';
export { createSchedulerListTool } from './scheduler_list';
export { createSchedulerUpdateTool } from './scheduler_update';
export { createSchedulerDeleteTool } from './scheduler_delete';
export { createSchedulerToggleTool } from './scheduler_toggle';
export { createSchedulerRunTool } from './scheduler_run';
export { createSettingsListTool } from './settings_list';
export { createSettingsGetTool } from './settings_get';
export { createKanbanScreenshotTool } from './kanban_screenshot';

import { createKanbanCreateTool } from './kanban_create';
import { createKanbanListTool } from './kanban_list';
import { createKanbanGetTool } from './kanban_get';
import { createKanbanUpdateTool } from './kanban_update';
import { createKanbanDeleteTool } from './kanban_delete';
import { createKanbanArchiveTool } from './kanban_archive';
import { createSchedulerCreateTool } from './scheduler_create';
import { createSchedulerListTool } from './scheduler_list';
import { createSchedulerUpdateTool } from './scheduler_update';
import { createSchedulerDeleteTool } from './scheduler_delete';
import { createSchedulerToggleTool } from './scheduler_toggle';
import { createSchedulerRunTool } from './scheduler_run';
import { createSettingsListTool } from './settings_list';
import { createSettingsGetTool } from './settings_get';
import { createKanbanScreenshotTool } from './kanban_screenshot';

export function createKanbanTools(
  store: KanbanStore,
  input: PluginInput,
): Record<string, ToolDefinition> {
  return {
    kanban_create: createKanbanCreateTool(store, input),
    kanban_list: createKanbanListTool(store, input),
    kanban_get: createKanbanGetTool(store, input),
    kanban_update: createKanbanUpdateTool(store, input),
    kanban_delete: createKanbanDeleteTool(store, input),
    kanban_archive: createKanbanArchiveTool(store, input),
    kanban_screenshot: createKanbanScreenshotTool(store, input),
  };
}

export function createSchedulerTools(
  store: SchedulerStore,
  engine: SchedulerEngine,
  input: PluginInput,
): Record<string, ToolDefinition> {
  return {
    scheduler_create: createSchedulerCreateTool(store, engine, input),
    scheduler_list: createSchedulerListTool(store, engine, input),
    scheduler_update: createSchedulerUpdateTool(store, engine, input),
    scheduler_delete: createSchedulerDeleteTool(store, engine, input),
    scheduler_toggle: createSchedulerToggleTool(store, engine, input),
    scheduler_run: createSchedulerRunTool(store, engine, input),
  };
}

export function createSettingsTools(
  store: SettingsStore,
  input: PluginInput,
): Record<string, ToolDefinition> {
  return {
    settings_list: createSettingsListTool(store, input),
    settings_get: createSettingsGetTool(store, input),
  };
}
