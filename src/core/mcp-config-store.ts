import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { McpInventoryItem, McpPlacement, McpServerDef } from './types';
import { FileLock } from './filelock';
import { detectPlaintextSecret } from './secret-detect';

// Re-export for backward compatibility
export { detectPlaintextSecret } from './secret-detect';

export const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');

interface ClaudeJson {
  mcpServers?: Record<string, McpServerDef>;
  projects?: Record<string, { mcpServers?: Record<string, McpServerDef>; [k: string]: unknown }>;
  [k: string]: unknown;
}

// ─── Etag helpers ──────────────────────────────────────────────────────────────

interface Etag {
  mtime: number;
  sha256: string;
}

function captureEtag(filePath: string): Etag | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const stat = statSync(filePath);
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    return { mtime: stat.mtimeMs, sha256 };
  } catch {
    return null;
  }
}

function etagEqual(a: Etag, b: Etag): boolean {
  return a.mtime === b.mtime && a.sha256 === b.sha256;
}

// ─── Atomic write ──────────────────────────────────────────────────────────────

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  let mode = 0o600;
  if (existsSync(filePath)) {
    try { mode = statSync(filePath).mode & 0o777; } catch { /* ignore */ }
  }
  const fd = openSync(tmpPath, 'w', mode);
  try {
    const buf = Buffer.from(content, 'utf8');
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  // fsync parent dir — best-effort (not supported on all platforms)
  try {
    const parentFd = openSync(dirname(filePath), 'r');
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch { /* non-fatal */ }
}

// ─── Backup ────────────────────────────────────────────────────────────────────

export function backupClaudeJson(claudeJsonPath: string, backupDir: string, ts: string): void {
  if (!existsSync(claudeJsonPath)) return;
  mkdirSync(backupDir, { recursive: true });
  const content = readFileSync(claudeJsonPath, 'utf8');
  writeFileSync(join(backupDir, `claude.json.${ts}.bak`), content, { encoding: 'utf8' });
}

// ─── Mutator helpers ───────────────────────────────────────────────────────────

function addToUserScope(obj: ClaudeJson, name: string, def: McpServerDef): ClaudeJson {
  return { ...obj, mcpServers: { ...(obj.mcpServers ?? {}), [name]: def } };
}

function removeFromUserScope(obj: ClaudeJson, name: string): ClaudeJson {
  const servers = { ...(obj.mcpServers ?? {}) };
  delete servers[name];
  return { ...obj, mcpServers: servers };
}

function addToLocalScope(obj: ClaudeJson, dir: string, name: string, def: McpServerDef): ClaudeJson {
  const projects = { ...(obj.projects ?? {}) };
  const project = { ...(projects[dir] ?? {}) };
  project.mcpServers = { ...(project.mcpServers ?? {}), [name]: def };
  projects[dir] = project;
  return { ...obj, projects };
}

function removeFromLocalScope(obj: ClaudeJson, dir: string, name: string): ClaudeJson {
  const projects = { ...(obj.projects ?? {}) };
  if (!projects[dir]) return obj;
  const project = { ...(projects[dir]) };
  const servers = { ...(project.mcpServers ?? {}) };
  delete servers[name];
  project.mcpServers = servers;
  projects[dir] = project;
  return { ...obj, projects };
}

// ─── File locks ───────────────────────────────────────────────────────────────

const _mcpFileLocks = new Map<string, FileLock>();

function getMcpFileLock(filePath: string): FileLock {
  if (!_mcpFileLocks.has(filePath)) {
    _mcpFileLocks.set(filePath, new FileLock(`${filePath}.lock`));
  }
  return _mcpFileLocks.get(filePath)!;
}

// ─── CAS write engine ─────────────────────────────────────────────────────────

export interface SafeMutateOpts {
  /** ISO timestamp string used as backup filename suffix. */
  ts: string;
  /** Directory where backup files are written. */
  backupDir: string;
  /** Override for testing (defaults to CLAUDE_JSON_PATH). */
  claudeJsonPath?: string;
  /** Max merge-retry attempts (default 5). */
  maxRetries?: number;
  /** Set to true to skip the post-write diff verification (for testing). */
  skipVerify?: boolean;
}

/**
 * CAS (compare-and-swap) safe writer for ~/.claude.json.
 *
 * 1. Backup → 2. Read+etag → 3. Apply mutator → 4. Pre-write etag recheck
 * → 5. Atomic fsync+rename → 6. Post-write diff verify → 7. Rollback on mismatch.
 *
 * Claude Code writes the same file concurrently and does not respect our FileLock.
 * The etag recheck catches external writes between our read and write.
 */
export async function safeMutateClaudeJson(
  mutator: (obj: ClaudeJson) => ClaudeJson,
  opts: SafeMutateOpts,
): Promise<{ before: string; after: string }> {
  const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
  const maxRetries = opts.maxRetries ?? 5;

  let resultBefore = '';
  let resultAfter = '';

  const lock = getMcpFileLock(filePath);

  await lock.withLock(async () => {
    // Step 1: Backup before any mutation
    backupClaudeJson(filePath, opts.backupDir, opts.ts);

    // Step 2: Read initial content + etag
    const initialContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
    resultBefore = initialContent;
    let currentContent = initialContent;
    let currentEtag = captureEtag(filePath) ?? {
      mtime: 0,
      sha256: createHash('sha256').update('{}', 'utf8').digest('hex'),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Parse
      let currentObj: ClaudeJson;
      try {
        currentObj = JSON.parse(currentContent) as ClaudeJson;
      } catch {
        throw new Error('Invalid JSON in ~/.claude.json');
      }

      const newObj = mutator(currentObj);
      const newContent = JSON.stringify(newObj, null, 2) + '\n';

      // Step 3: Pre-write etag recheck
      const nowEtag = captureEtag(filePath) ?? { mtime: 0, sha256: '' };
      if (!etagEqual(currentEtag, nowEtag)) {
        if (attempt >= maxRetries) {
          throw Object.assign(
            new Error(
              'Concurrent write conflict: another process modified ~/.claude.json. ' +
                'Max retries exceeded — apply aborted.',
            ),
            { code: 'CONFLICT_409' },
          );
        }
        // Re-read + backoff before next attempt
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        currentContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
        currentEtag = captureEtag(filePath) ?? { mtime: 0, sha256: '' };
        continue;
      }

      // Step 4: Atomic write (temp → fsync → rename → fsync parent)
      atomicWrite(filePath, newContent);

      // Step 5: Post-write diff verify (unless skipped in tests)
      if (!opts.skipVerify) {
        let written: string;
        try {
          written = readFileSync(filePath, 'utf8');
        } catch {
          throw new Error('Post-write verification: could not re-read file after write');
        }

        const writtenNorm = JSON.stringify(JSON.parse(written));
        const expectedNorm = JSON.stringify(newObj);

        if (writtenNorm !== expectedNorm) {
          // Rollback from backup
          const backupPath = join(opts.backupDir, `claude.json.${opts.ts}.bak`);
          if (existsSync(backupPath)) {
            atomicWrite(filePath, readFileSync(backupPath, 'utf8'));
          }
          throw new Error(
            'Post-write verification failed: unexpected content mismatch. Rolled back from backup.',
          );
        }
        resultAfter = written;
      } else {
        resultAfter = newContent;
      }

      return;
    }

    // Should not reach here (loop always throws or returns), but just in case
    throw Object.assign(new Error('safeMutateClaudeJson: all retries exhausted'), {
      code: 'CONFLICT_409',
    });
  });

  return { before: resultBefore, after: resultAfter };
}

// ─── CLI detection ────────────────────────────────────────────────────────────

let _claudeCliPath: string | null | undefined;

function detectClaudeCli(): string | null {
  if (_claudeCliPath !== undefined) return _claudeCliPath;
  try {
    const result = execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim();
    _claudeCliPath = result || null;
  } catch {
    _claudeCliPath = null;
  }
  return _claudeCliPath;
}

/** Reset CLI cache (for testing). */
export function _resetClaudeCliCache(): void {
  _claudeCliPath = undefined;
}

function buildMcpAddArgs(name: string, def: McpServerDef, scope: string): string[] {
  const args = ['mcp', 'add', '-s', scope, name];
  if (def.type === 'http' || def.type === 'sse') {
    if (def.type === 'sse') args.push('--sse');
    if (def.url) args.push('--url', def.url as string);
  } else {
    // stdio (default)
    if (def.command) {
      args.push(def.command);
      if (def.args && def.args.length > 0) args.push(...def.args);
    }
  }
  if (def.env) {
    for (const [k, v] of Object.entries(def.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  return args;
}

function tryClaudeMcpAdd(name: string, def: McpServerDef, scope: string, cwd?: string): boolean {
  const claudePath = detectClaudeCli();
  if (!claudePath) return false;
  try {
    execFileSync(claudePath, buildMcpAddArgs(name, def, scope), {
      cwd: cwd ?? homedir(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function tryClaudeMcpRemove(name: string, scope: string, cwd?: string): boolean {
  const claudePath = detectClaudeCli();
  if (!claudePath) return false;
  try {
    execFileSync(claudePath, ['mcp', 'remove', name, '-s', scope], {
      cwd: cwd ?? homedir(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── .mcp.json helpers (project scope) ───────────────────────────────────────

function readMcpJsonFile(filePath: string): Record<string, McpServerDef> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      mcpServers?: Record<string, McpServerDef>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

function writeMcpJsonFile(
  filePath: string,
  servers: Record<string, McpServerDef>,
): { before: string; after: string } {
  const before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const existing = before
    ? (JSON.parse(before) as { mcpServers?: Record<string, McpServerDef>; [k: string]: unknown })
    : {};
  const newObj = { ...existing, mcpServers: servers };
  const after = JSON.stringify(newObj, null, 2) + '\n';
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWrite(filePath, after);
  return { before, after };
}

// ─── Public write operations ──────────────────────────────────────────────────

export interface McpWriteOpts {
  /** ISO timestamp for backup filename. Must be provided by the route handler. */
  ts: string;
  /** Backup directory (typically <dataDir>/cold-storage/backups). */
  backupDir: string;
  /** Required for local scope (identifies the project directory key in ~/.claude.json). */
  targetDir?: string;
  /** For project scope: the repo directory containing .mcp.json. */
  projectDir?: string;
  /** Override claude.json path (for testing). */
  claudeJsonPath?: string;
}

/**
 * Copy an MCP server definition to a target scope.
 * Source definition is not modified.
 * Blocks with `{ secretWarning: true }` when copying to a teamShared (project) scope
 * unless `forceSecret` is true.
 */
export async function copyMcp(
  name: string,
  sourceDef: McpServerDef,
  toScope: 'user' | 'local' | 'project',
  opts: McpWriteOpts,
  forceSecret = false,
): Promise<{ before: string; after: string; secretWarning?: boolean }> {
  if (toScope === 'project') {
    if (!opts.projectDir) throw new Error('projectDir required for project scope');
    if (!forceSecret && detectPlaintextSecret(sourceDef)) {
      return { before: '', after: '', secretWarning: true };
    }
    const mcpJsonPath = join(opts.projectDir, '.mcp.json');
    const servers = readMcpJsonFile(mcpJsonPath);
    servers[name] = sourceDef;
    return writeMcpJsonFile(mcpJsonPath, servers);
  }

  // CLI path is only valid when operating on the real ~/.claude.json.
  // A custom claudeJsonPath means we are in a test/override context where the
  // CLI would write to the actual file instead of the overridden path.
  const useRealFile = !opts.claudeJsonPath || opts.claudeJsonPath === CLAUDE_JSON_PATH;

  if (toScope === 'local') {
    if (!opts.targetDir) throw new Error('targetDir required for local scope');
    const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
    backupClaudeJson(filePath, opts.backupDir, opts.ts);
    const dir = opts.targetDir;
    if (useRealFile) {
      const cliOk = tryClaudeMcpAdd(name, sourceDef, 'local', dir);
      if (cliOk) {
        const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
        return { before: '', after };
      }
    }
    return safeMutateClaudeJson((obj) => addToLocalScope(obj, dir, name, sourceDef), opts);
  }

  if (toScope === 'user') {
    const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
    backupClaudeJson(filePath, opts.backupDir, opts.ts);
    if (useRealFile) {
      const cliOk = tryClaudeMcpAdd(name, sourceDef, 'user');
      if (cliOk) {
        const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
        return { before: '', after };
      }
    }
    return safeMutateClaudeJson((obj) => addToUserScope(obj, name, sourceDef), opts);
  }

  throw new Error(`Unknown toScope: ${String(toScope)}`);
}

/**
 * Move an MCP server definition from one scope to another.
 * When both source and destination are in ~/.claude.json, the operation is atomic
 * (single `safeMutateClaudeJson` call).
 */
export async function moveMcp(
  name: string,
  sourceDef: McpServerDef,
  fromScope: 'user' | 'local' | 'project',
  fromDir: string | undefined,
  toScope: 'user' | 'local' | 'project',
  opts: McpWriteOpts,
  forceSecret = false,
): Promise<{ before: string; after: string; secretWarning?: boolean }> {
  // Check secret before starting
  const toTeamShared = toScope === 'project';
  if (toTeamShared && !forceSecret && detectPlaintextSecret(sourceDef)) {
    return { before: '', after: '', secretWarning: true };
  }

  const sameFile = fromScope !== 'project' && toScope !== 'project';

  if (sameFile) {
    // Single atomic transaction in ~/.claude.json
    const dir = opts.targetDir;
    const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
    backupClaudeJson(filePath, opts.backupDir, opts.ts);
    return safeMutateClaudeJson((obj) => {
      let result = obj;
      if (fromScope === 'user') result = removeFromUserScope(result, name);
      else if (fromScope === 'local' && fromDir) result = removeFromLocalScope(result, fromDir, name);
      if (toScope === 'user') result = addToUserScope(result, name, sourceDef);
      else if (toScope === 'local' && dir) result = addToLocalScope(result, dir, name, sourceDef);
      return result;
    }, opts);
  }

  // Cross-file: copy to project .mcp.json, then remove from source
  if (toScope === 'project') {
    if (!opts.projectDir) throw new Error('projectDir required for project scope');
    const mcpJsonPath = join(opts.projectDir, '.mcp.json');
    const servers = readMcpJsonFile(mcpJsonPath);
    servers[name] = sourceDef;
    const { before, after } = writeMcpJsonFile(mcpJsonPath, servers);

    // Now remove from source (user or local in ~/.claude.json)
    const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
    backupClaudeJson(filePath, opts.backupDir, opts.ts);
    if (fromScope === 'user') {
      const cliOk = tryClaudeMcpRemove(name, 'user');
      if (!cliOk) {
        await safeMutateClaudeJson((obj) => removeFromUserScope(obj, name), opts);
      }
    } else if (fromScope === 'local' && fromDir) {
      const cliOk = tryClaudeMcpRemove(name, 'local', fromDir);
      if (!cliOk) {
        await safeMutateClaudeJson(
          (obj) => removeFromLocalScope(obj, fromDir, name),
          opts,
        );
      }
    }
    return { before, after };
  }

  // Cross-file: moving from project to user/local
  // 1. Add to destination in ~/.claude.json
  await copyMcp(name, sourceDef, toScope, opts, true);

  // 2. Remove from project .mcp.json
  if (fromScope === 'project') {
    const mcpJsonPath = join(fromDir ?? '', '.mcp.json');
    const servers = readMcpJsonFile(mcpJsonPath);
    delete servers[name];
    writeMcpJsonFile(mcpJsonPath, servers);
  }

  const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
  const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
  return { before: '', after };
}

/**
 * Remove an MCP server from a given scope.
 */
export async function removeMcp(
  name: string,
  scope: 'user' | 'local' | 'project',
  opts: McpWriteOpts,
): Promise<{ before: string; after: string }> {
  if (scope === 'project') {
    if (!opts.projectDir) throw new Error('projectDir required for project scope');
    const mcpJsonPath = join(opts.projectDir, '.mcp.json');
    const servers = readMcpJsonFile(mcpJsonPath);
    const before = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf8') : '';
    delete servers[name];
    writeMcpJsonFile(mcpJsonPath, servers);
    const after = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf8') : '{}';
    return { before, after };
  }

  const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;
  const before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
  const useRealFile = !opts.claudeJsonPath || opts.claudeJsonPath === CLAUDE_JSON_PATH;

  // Backup before CLI or direct edit
  backupClaudeJson(filePath, opts.backupDir, opts.ts);

  if (scope === 'user') {
    if (useRealFile) {
      const cliOk = tryClaudeMcpRemove(name, 'user');
      if (cliOk) {
        const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
        return { before, after };
      }
    }
    return safeMutateClaudeJson((obj) => removeFromUserScope(obj, name), opts);
  }

  if (scope === 'local') {
    if (!opts.targetDir) throw new Error('targetDir required for local scope remove');
    const dir = opts.targetDir;
    if (useRealFile) {
      const cliOk = tryClaudeMcpRemove(name, 'local', dir);
      if (cliOk) {
        const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}';
        return { before, after };
      }
    }
    return safeMutateClaudeJson((obj) => removeFromLocalScope(obj, dir, name), opts);
  }

  throw new Error(`Unknown scope: ${String(scope)}`);
}

// ─── Read inventory (unchanged from Phase 1) ─────────────────────────────────

function parseClaudeJson(filePath: string = CLAUDE_JSON_PATH): ClaudeJson | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as ClaudeJson;
  } catch {
    return null;
  }
}

/**
 * Read-only MCP inventory from ~/.claude.json (user + local scopes) and
 * registered project dirs' .mcp.json files (project scope).
 */
export async function readMcpInventory(
  projectDirs: string[] = [],
  claudeJsonPath: string = CLAUDE_JSON_PATH,
): Promise<McpInventoryItem[]> {
  const claudeJson = parseClaudeJson(claudeJsonPath);
  const serverMap = new Map<string, { def: McpServerDef; placements: McpPlacement[] }>();

  function addPlacement(name: string, def: McpServerDef, placement: McpPlacement) {
    if (!serverMap.has(name)) {
      serverMap.set(name, { def, placements: [] });
    }
    serverMap.get(name)!.placements.push(placement);
  }

  if (claudeJson?.mcpServers) {
    for (const [name, def] of Object.entries(claudeJson.mcpServers)) {
      addPlacement(name, def, {
        scope: 'user',
        location: claudeJsonPath,
        alwaysLoad: (def.alwaysLoad as boolean) ?? false,
        hasPlaintextSecret: detectPlaintextSecret(def),
        managed: false,
      });
    }
  }

  if (claudeJson?.projects) {
    for (const [projectKey, projectData] of Object.entries(claudeJson.projects)) {
      if (!projectData.mcpServers) continue;
      for (const [name, def] of Object.entries(projectData.mcpServers)) {
        addPlacement(name, def, {
          scope: 'local',
          location: claudeJsonPath,
          dir: projectKey,
          alwaysLoad: (def.alwaysLoad as boolean) ?? false,
          hasPlaintextSecret: detectPlaintextSecret(def),
          managed: false,
        });
      }
    }
  }

  for (const dir of projectDirs) {
    const mcpJsonPath = join(dir, '.mcp.json');
    const servers = readMcpJsonFile(mcpJsonPath);
    for (const [name, def] of Object.entries(servers)) {
      addPlacement(name, def, {
        scope: 'project',
        location: mcpJsonPath,
        dir,
        alwaysLoad: (def.alwaysLoad as boolean) ?? false,
        hasPlaintextSecret: detectPlaintextSecret(def),
        managed: false,
      });
    }
  }

  const items: McpInventoryItem[] = [];
  for (const [name, { def, placements }] of serverMap) {
    const anyAlwaysLoad = placements.some((p) => p.alwaysLoad);
    items.push({
      name,
      def,
      placements,
      status: 'unknown',
      preloadReason: anyAlwaysLoad ? 'alwaysLoad' : null,
    });
  }

  return items;
}

// ─── alwaysLoad helpers (Phase 2, unchanged) ─────────────────────────────────

export function applyAlwaysLoad(
  content: string,
  serverName: string,
  alwaysLoad: boolean,
): string {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON in MCP config file');
  }

  const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
  if (!servers || !(serverName in servers)) {
    throw new Error(`MCP server "${serverName}" not found in config`);
  }

  const serverDef = { ...servers[serverName] };
  if (alwaysLoad) {
    serverDef.alwaysLoad = true;
  } else {
    delete serverDef.alwaysLoad;
  }

  const newConfig = { ...config, mcpServers: { ...servers, [serverName]: serverDef } };
  return JSON.stringify(newConfig, null, 2) + '\n';
}

export async function setAlwaysLoad(
  location: string,
  serverName: string,
  alwaysLoad: boolean,
): Promise<{ oldContent: string; newContent: string }> {
  if (!existsSync(location)) {
    throw new Error(`MCP config file not found: ${location}`);
  }

  const oldContent = readFileSync(location, 'utf8');
  const newContent = applyAlwaysLoad(oldContent, serverName, alwaysLoad);

  if (oldContent === newContent) {
    return { oldContent, newContent };
  }

  await getMcpFileLock(location).withLock(async () => {
    const current = readFileSync(location, 'utf8');
    const recomputed = applyAlwaysLoad(current, serverName, alwaysLoad);
    const tmpPath = `${location}.tmp`;
    writeFileSync(tmpPath, recomputed, 'utf8');
    renameSync(tmpPath, location);
  });

  return { oldContent, newContent };
}
