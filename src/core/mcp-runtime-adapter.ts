import type {
  McpInventoryItem,
  McpInventoryDiscoveryResult,
  McpRuntime,
  McpServerDef,
  PlacementTarget,
  WritableMcpScope,
} from './types';
import {
  copyMcp,
  moveMcp,
  readMcpInventory,
  removeMcp,
  type McpWriteOpts,
} from './mcp-config-store';
import {
  copyCodexMcp,
  discoverCodexMcpInventory,
  moveCodexMcp,
  readCodexMcpInventory,
  removeCodexMcp,
  type CodexMcpWriteOpts,
} from './codex-mcp-config';

export type McpWriteResult = { before: string; after: string; secretWarning?: boolean };

export interface McpRuntimeAdapter {
  readonly runtime: McpRuntime;
  readonly capabilities: { alwaysLoad: boolean };
  readInventory(targets: PlacementTarget[]): Promise<McpInventoryItem[]>;
  copy(
    name: string,
    def: McpServerDef,
    toScope: WritableMcpScope,
    opts: McpWriteOpts & CodexMcpWriteOpts,
    forceSecret?: boolean,
  ): Promise<McpWriteResult>;
  move(
    name: string,
    def: McpServerDef,
    fromScope: WritableMcpScope,
    fromDir: string | undefined,
    toScope: WritableMcpScope,
    opts: McpWriteOpts & CodexMcpWriteOpts,
    forceSecret?: boolean,
  ): Promise<McpWriteResult>;
  remove(
    name: string,
    scope: WritableMcpScope,
    opts: McpWriteOpts & CodexMcpWriteOpts,
  ): Promise<McpWriteResult>;
}

const claudeAdapter: McpRuntimeAdapter = {
  runtime: 'claude',
  capabilities: { alwaysLoad: true },
  readInventory(targets) {
    return readMcpInventory(
      targets
        .filter((target) => target.runtime === 'claude' &&
          (target.kind === 'project' || target.kind === 'local'))
        .map((target) => target.dir),
    );
  },
  copy: copyMcp,
  move: moveMcp,
  remove: removeMcp,
};

const codexAdapter: McpRuntimeAdapter = {
  runtime: 'codex',
  capabilities: { alwaysLoad: false },
  readInventory(targets) {
    return readCodexMcpInventory(
      targets
        .filter((target) => target.runtime === 'codex' &&
          (target.kind === 'project' || target.kind === 'local'))
        .map((target) => ({
          dir: target.dir,
          scope: target.kind === 'local' ? 'local' as const : 'project' as const,
        })),
    );
  },
  copy: copyCodexMcp,
  move: moveCodexMcp,
  remove: removeCodexMcp,
};

export function getMcpRuntimeAdapter(runtime: McpRuntime): McpRuntimeAdapter {
  return runtime === 'codex' ? codexAdapter : claudeAdapter;
}

export interface McpInventoryReadOptions {
  claudeJsonPath?: string;
  codexUserConfigPath?: string;
}

function claudeProjectDirs(targets: PlacementTarget[]): string[] {
  return targets
    .filter((target) => target.runtime === 'claude' &&
      (target.kind === 'project' || target.kind === 'local'))
    .map((target) => target.dir);
}

function codexProjectTargets(targets: PlacementTarget[]) {
  return targets
    .filter((target) => target.runtime === 'codex' &&
      (target.kind === 'project' || target.kind === 'local'))
    .map((target) => ({
      dir: target.dir,
      scope: target.kind === 'local' ? 'local' as const : 'project' as const,
    }));
}

export async function readAllMcpInventoryWithDiagnostics(
  targets: PlacementTarget[] = [],
  options: McpInventoryReadOptions = {},
): Promise<McpInventoryDiscoveryResult> {
  const claudePromise = readMcpInventory(
    claudeProjectDirs(targets),
    options.claudeJsonPath,
  );
  const codexPromise = discoverCodexMcpInventory(
    codexProjectTargets(targets),
    options.codexUserConfigPath,
  );
  const [claude, codex] = await Promise.allSettled([claudePromise, codexPromise]);

  const codexDiagnostics = codex.status === 'fulfilled'
    ? codex.value.diagnostics
    : {
        candidateConfigPaths: [],
        scannedConfigPaths: [],
        issues: [{
          runtime: 'codex' as const,
          path: options.codexUserConfigPath ?? '~/.codex/config.toml',
          code: 'scan-failed' as const,
          message: codex.reason instanceof Error ? codex.reason.message : 'Codex MCP scan failed',
        }],
        projectTrust: { required: false, status: 'unknown' as const, configPaths: [] },
      };

  return {
    items: [
      ...(claude.status === 'fulfilled' ? claude.value : []),
      ...(codex.status === 'fulfilled' ? codex.value.items : []),
    ],
    diagnostics: { codex: codexDiagnostics },
  };
}

export async function readAllMcpInventory(
  targets: PlacementTarget[] = [],
): Promise<McpInventoryItem[]> {
  return (await readAllMcpInventoryWithDiagnostics(targets)).items;
}
