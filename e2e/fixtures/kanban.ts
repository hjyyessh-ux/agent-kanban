import { test as base } from '@playwright/test';
import { apiCreateCard, apiUpdateCard, apiDeleteCard } from '../helpers/api';

interface Card {
  id: string;
  title: string;
  description: string;
  status: string;
  [key: string]: unknown;
}

export const test = base.extend<{
  trackCard: (id: string) => void;
  seedCard: (data: { title: string; description: string } & Record<string, unknown>) => Promise<Card>;
  seedCardWithStatus: (data: { title: string; description: string } & Record<string, unknown>, status: string, extras?: Record<string, unknown>) => Promise<Card>;
}>({
  trackCard: async ({}, use) => {
    const ids: string[] = [];
    await use((id: string) => { ids.push(id); });
    // Cleanup: delete all tracked cards
    for (const id of ids) {
      try { await apiDeleteCard(id); } catch { /* ignore */ }
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
});

export { expect } from '@playwright/test';
