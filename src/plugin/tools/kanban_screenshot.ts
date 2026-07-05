import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';
import { extname } from 'node:path';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

export function createKanbanScreenshotTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Attach a screenshot to a kanban card. Reads the file from the given path, stores it in the screenshots directory, and links it to the card.',
    args: {
      cardId: z.string().describe('ID of the kanban card to attach the screenshot to'),
      filePath: z.string().describe('Absolute path to the screenshot file on disk'),
    },
    async execute(args) {
      const file = Bun.file(args.filePath);
      const exists = await file.exists();
      if (!exists) {
        return JSON.stringify({ error: `File not found: ${args.filePath}` });
      }

      const arrayBuffer = await file.arrayBuffer();
      const ext = extname(args.filePath).toLowerCase();
      const mimeType = MIME_MAP[ext] || 'application/octet-stream';
      const originalName = args.filePath.split('/').pop() || 'screenshot';

      const screenshot = await store.saveScreenshot(args.cardId, arrayBuffer, originalName, mimeType);
      return JSON.stringify({
        message: `✅ Screenshot attached to card #${args.cardId}`,
        screenshot: {
          id: screenshot.id,
          filename: screenshot.filename,
          originalName: screenshot.originalName,
          mimeType: screenshot.mimeType,
          size: screenshot.size,
        },
      });
    },
  });
}
