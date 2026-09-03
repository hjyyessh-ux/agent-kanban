import { test as base } from '@playwright/test';
import type {
  CreateQuickActionInput,
  CreateWorkInput,
  QuickActionView,
  Work,
} from '../../src/core/types';
import {
  apiCreateCard,
  apiCreateQuickAction,
  apiCreateScript,
  apiCreateWork,
  apiDeleteCard,
  apiDeleteQuickAction,
  apiDeleteScript,
  apiDeleteWork,
  apiUpdateCard,
  type ScriptEntry,
} from '../helpers/api';

interface Card {
  id: string;
  title: string;
  description: string;
  status: string;
  [key: string]: unknown;
}

export const test = base.extend<{
  trackCard: (id: string) => void;
  trackQuickAction: (id: string) => void;
  trackScript: (id: string) => void;
  seedCard: (data: { title: string; description: string } & Record<string, unknown>) => Promise<Card>;
  seedCardWithStatus: (data: { title: string; description: string } & Record<string, unknown>, status: string, extras?: Record<string, unknown>) => Promise<Card>;
  seedQuickAction: (data: CreateQuickActionInput) => Promise<QuickActionView>;
  seedScript: (data: { name: string; content: string; description?: string; language?: string; projectDir?: string }) => Promise<ScriptEntry>;
  trackWork: (id: string) => void;
  seedWork: (data: CreateWorkInput) => Promise<Work>;
}>({
  trackCard: async ({}, use) => {
    const ids: string[] = [];
    await use((id: string) => { ids.push(id); });
    // Cleanup: delete all tracked cards
    for (const id of ids) {
      try { await apiDeleteCard(id); } catch { /* ignore */ }
    }
  },

  trackQuickAction: async ({ trackScript }, use) => {
    // Establish a fixture dependency so referenced Quick Actions are removed
    // before trackScript attempts to delete their ScriptEntries.
    void trackScript;
    const ids: string[] = [];
    await use((id: string) => { ids.push(id); });
    for (const id of ids.reverse()) {
      try { await apiDeleteQuickAction(id); } catch { /* ignore */ }
    }
  },

  trackScript: async ({}, use) => {
    const ids: string[] = [];
    await use((id: string) => { ids.push(id); });
    for (const id of ids.reverse()) {
      try { await apiDeleteScript(id); } catch { /* ignore */ }
    }
  },

  seedCard: async ({ trackCard }, use) => {
    await use(async (data) => {
      const card = await apiCreateCard(data);
      trackCard(card.id);
      return card;
    });
  },

  seedCardWithStatus: async ({ trackCard }, use) => {
    await use(async (data, status, extras = {}) => {
      const card = await apiCreateCard(data);
      trackCard(card.id);
      if (status !== 'todo' || Object.keys(extras).length > 0) {
        const updated = await apiUpdateCard(card.id, { status, ...extras });
        return updated;
      }
      return card;
    });
  },

  seedQuickAction: async ({ trackQuickAction }, use) => {
    await use(async (data) => {
      const action = await apiCreateQuickAction(data);
      trackQuickAction(action.id);
      return action;
    });
  },

  seedScript: async ({ trackScript }, use) => {
    await use(async (data) => {
      const script = await apiCreateScript(data);
      trackScript(script.id);
      return script;
    });
  },

  trackWork: async ({}, use) => {
    const ids: string[] = [];
    await use((id: string) => { ids.push(id); });
    // Deleting a Work releases its sessions back into the Inbox, so teardown
    // order relative to trackCard does not matter — the cards go away too.
    for (const id of ids.reverse()) {
      try { await apiDeleteWork(id); } catch { /* ignore */ }
    }
  },

  seedWork: async ({ trackWork }, use) => {
    await use(async (data) => {
      const work = await apiCreateWork(data);
      trackWork(work.id);
      return work;
    });
  },
});

export { expect } from '@playwright/test';
