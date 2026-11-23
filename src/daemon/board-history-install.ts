/**
 * One-time install of the dedicated board-history consumer.
 *
 *   <token-source> | bun run src/daemon/board-history-install.ts [subscription-id]
 *
 * The token is read from stdin only (never argv/env, which leak to `ps`/logs)
 * and only its SHA-256 is persisted. Keep the plaintext in the consumer's own
 * credential storage. Board files are read under their locks, never written.
 */
import { getKanbanDataDir } from '../plugin/config';
import { installBoardHistory } from '../core/board-history';

const subscriptionId = process.argv[2] ?? 'dot';
const token = (await new Response(Bun.stdin.stream()).text()).trim();
try {
  const result = await installBoardHistory({ dataDir: getKanbanDataDir(), subscriptionId, token });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'board_history_install_failed';
  process.stderr.write(code + '\n');
  process.exit(1);
}
