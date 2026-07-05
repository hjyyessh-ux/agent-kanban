import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DiscoveredSkill, CapScope, McpServerDef, ColdManifestEntry } from './types';
import { FileLock } from './filelock';
import { resolveKanbanDataDir } from './data-dir';
import {
  safeMutateClaudeJson,
  CLAUDE_JSON_PATH,
  backupClaudeJson,
  copyMcp,
} from './mcp-config-store';

// ─── Directory helpers ───────────────────────────────────────────────────────

export function resolveColdStorageDir(): string {
  const base = resolveKanbanDataDir();
  const dir = join(base, 'cold-storage');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── MCP Registry type ───────────────────────────────────────────────────────

interface McpRegistryEntry {
  def: McpServerDef;
  originScope: CapScope;
  frozenAt: string;
  hash: string;
}

interface McpRegistry {
  servers: Record<string, McpRegistryEntry>;
}

// ─── Lazy-initialized locks ───────────────────────────────────────────────────

let _manifestLock: FileLock | undefined;
let _mcpRegLock: FileLock | undefined;

function getManifestLock(): FileLock {
  if (!_manifestLock) {
    _manifestLock = new FileLock(join(resolveColdStorageDir(), 'manifest.lock'));
  }
  return _manifestLock;
}

function getMcpRegLock(): FileLock {
  if (!_mcpRegLock) {
    const d = join(resolveColdStorageDir(), 'mcp');
    mkdirSync(d, { recursive: true });
    _mcpRegLock = new FileLock(join(d, 'registry.lock'));
  }
  return _mcpRegLock;
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, Buffer.from(content, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

function manifestPath(): string {
  return join(resolveColdStorageDir(), 'manifest.json');
}

function readManifest(): ColdManifestEntry[] {
  const p = manifestPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ColdManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(entries: ColdManifestEntry[]): void {
  atomicWriteFile(manifestPath(), JSON.stringify(entries, null, 2) + '\n');
}

// ─── MCP Registry helpers ────────────────────────────────────────────────────

function registryPath(): string {
  const d = join(resolveColdStorageDir(), 'mcp');
  mkdirSync(d, { recursive: true });
  return join(d, 'registry.json');
}

function readMcpRegistry(): McpRegistry {
  const p = registryPath();
  if (!existsSync(p)) return { servers: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as McpRegistry;
  } catch {
    return { servers: {} };
  }
}

function writeMcpRegistry(reg: McpRegistry): void {
  atomicWriteFile(registryPath(), JSON.stringify(reg, null, 2) + '\n');
}

// ─── Hash helpers ─────────────────────────────────────────────────────────────

export function hashDef(def: McpServerDef): string {
  return createHash('sha256').update(JSON.stringify(def), 'utf8').digest('hex');
}

export function hashDir(dir: string): string {
  const h = createHash('sha256');
  function walk(d: string): void {
    if (!existsSync(d)) return;
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const p = join(d, entry.name);
      h.update(entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        try { h.update(readFileSync(p)); } catch { /* skip unreadable */ }
      }
    }
  }
  walk(dir);
  return h.digest('hex');
}

// ─── Volume detection ─────────────────────────────────────────────────────────

function isSameVolume(pathA: string, pathB: string): boolean {
  try {
    const devA = statSync(existsSync(pathA) ? pathA : dirname(pathA)).dev;
    const devB = statSync(existsSync(pathB) ? pathB : dirname(pathB)).dev;
    return devA === devB;
  } catch {
    return false;
  }
}

// ─── Directory move / copy ────────────────────────────────────────────────────

function guardNotSymlink(p: string): void {
  const s = lstatSync(p);
  if (s.isSymbolicLink()) {
    throw Object.assign(
      new Error('Symlinks are not supported for cold storage operations'),
      { code: 'SYMLINK_REJECTED' },
    );
  }
}

/**
 * Move a directory: same-volume rename, cross-volume copy+hash-verify+unlink.
 * Rejects symlinks.
 */
export function safeMoveDir(src: string, dst: string): void {
  guardNotSymlink(src);
  if (existsSync(dst)) {
    throw Object.assign(new Error(`Destination already exists: ${dst}`), { code: 'CONFLICT_409' });
  }
  mkdirSync(dirname(dst), { recursive: true });

  if (isSameVolume(src, dst)) {
    renameSync(src, dst);
    return;
  }

  // Cross-volume: copy → hash verify → delete source
  const srcHash = hashDir(src);
  cpSync(src, dst, { recursive: true });
  if (hashDir(dst) !== srcHash) {
    try { rmSync(dst, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error('Cross-volume copy failed: hash mismatch. Source preserved.');
  }
  rmSync(src, { recursive: true, force: true });
}

/**
 * Copy a directory to dst, verifying hash integrity. Does not remove src.
 */
export function safeCopyDir(src: string, dst: string): void {
  guardNotSymlink(src);
  if (existsSync(dst)) {
    throw Object.assign(new Error(`Destination already exists: ${dst}`), { code: 'CONFLICT_409' });
  }
  mkdirSync(dirname(dst), { recursive: true });
  const srcHash = hashDir(src);
  cpSync(src, dst, { recursive: true });
  if (hashDir(dst) !== srcHash) {
    try { rmSync(dst, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error('Copy failed: hash mismatch.');
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function freezeSkill(skill: DiscoveredSkill): Promise<ColdManifestEntry> {
  if (!skill.directory) throw new Error('Skill has no directory');
  guardNotSymlink(skill.directory);

  const ref = `${skill.runtime}/${skill.skillName}`;
  const destDir = join(resolveColdStorageDir(), 'skills', skill.runtime, skill.skillName);

  if (existsSync(destDir)) {
    throw Object.assign(
      new Error(`Cold storage already contains: ${ref}`),
      { code: 'CONFLICT_409' },
    );
  }

  const hash = hashDir(skill.directory);

  return getManifestLock().withLock(async () => {
    const entries = readManifest();
    if (entries.find((e) => e.kind === 'skill' && e.ref === ref)) {
      throw Object.assign(
        new Error(`Cold manifest already has entry: ${ref}`),
        { code: 'CONFLICT_409' },
      );
    }

    safeMoveDir(skill.directory, destDir);

    const entry: ColdManifestEntry = {
      kind: 'skill',
      ref,
      runtime: skill.runtime,
      sourceScope: skill.scope as CapScope,
      sourcePath: skill.directory,
      hash,
      createdAt: new Date().toISOString(),
      restorePolicy: 'any',
    };
    entries.push(entry);
    writeManifest(entries);
    return entry;
  });
}

export async function restoreSkill(ref: string, targetDir: string): Promise<void> {
  const coldPath = join(resolveColdStorageDir(), 'skills', ref);
  if (!existsSync(coldPath)) {
    throw new Error(`Cold storage skill not found: ${ref}`);
  }

  return getManifestLock().withLock(async () => {
    safeCopyDir(coldPath, targetDir);
    rmSync(coldPath, { recursive: true, force: true });
    writeManifest(readManifest().filter((e) => !(e.kind === 'skill' && e.ref === ref)));
  });
}

export async function freezeMcp(
  name: string,
  def: McpServerDef,
  scope: CapScope,
  fromDir: string | undefined,
  opts: { ts: string; claudeJsonPath?: string },
): Promise<ColdManifestEntry> {
  const hash = hashDef(def);
  const backupDir = join(resolveColdStorageDir(), 'backups');
  const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;

  // Save to MCP registry first
  await getMcpRegLock().withLock(async () => {
    const reg = readMcpRegistry();
    reg.servers[name] = { def, originScope: scope, frozenAt: new Date().toISOString(), hash };
    writeMcpRegistry(reg);
  });

  // Remove from active config via CAS engine
  if (scope === 'user') {
    backupClaudeJson(filePath, backupDir, opts.ts);
    await safeMutateClaudeJson(
      (obj) => {
        const servers = { ...(obj.mcpServers ?? {}) };
        delete servers[name];
        return { ...obj, mcpServers: servers };
      },
      { ts: opts.ts, backupDir, claudeJsonPath: opts.claudeJsonPath },
    );
  } else if (scope === 'local' && fromDir) {
    backupClaudeJson(filePath, backupDir, opts.ts);
    await safeMutateClaudeJson(
      (obj) => {
        const projects = { ...(obj.projects ?? {}) };
        if (projects[fromDir]) {
          const project = { ...projects[fromDir] };
          const servers = { ...(project.mcpServers ?? {}) };
          delete servers[name];
          project.mcpServers = servers;
          projects[fromDir] = project;
        }
        return { ...obj, projects };
      },
      { ts: opts.ts, backupDir, claudeJsonPath: opts.claudeJsonPath },
    );
  } else if (scope === 'project' && fromDir) {
    const mcpJsonPath = join(fromDir, '.mcp.json');
    if (existsSync(mcpJsonPath)) {
      const content = readFileSync(mcpJsonPath, 'utf8');
      const parsed = JSON.parse(content) as {
        mcpServers?: Record<string, McpServerDef>;
        [k: string]: unknown;
      };
      const servers = { ...(parsed.mcpServers ?? {}) };
      delete servers[name];
      atomicWriteFile(mcpJsonPath, JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + '\n');
    }
  }

  const entry: ColdManifestEntry = {
    kind: 'mcp',
    ref: name,
    sourceScope: scope,
    sourcePath: scope === 'project' && fromDir ? join(fromDir, '.mcp.json') : filePath,
    projectRoot: fromDir,
    originalConfigJson: JSON.stringify(def),
    hash,
    createdAt: new Date().toISOString(),
    restorePolicy: 'any',
  };

  await getManifestLock().withLock(async () => {
    const entries = readManifest().filter((e) => !(e.kind === 'mcp' && e.ref === name));
    entries.push(entry);
    writeManifest(entries);
  });

  return entry;
}

export async function restoreMcp(
  ref: string,
  toScope: 'user' | 'local' | 'project',
  opts: { ts: string; targetDir?: string; projectDir?: string; claudeJsonPath?: string },
): Promise<void> {
  const reg = readMcpRegistry();
  const regEntry = reg.servers[ref];
  if (!regEntry) throw new Error(`Cold storage MCP not found: ${ref}`);

  const backupDir = join(resolveColdStorageDir(), 'backups');
  await copyMcp(ref, regEntry.def, toScope, {
    ts: opts.ts,
    backupDir,
    targetDir: opts.targetDir,
    projectDir: opts.projectDir,
    claudeJsonPath: opts.claudeJsonPath,
  });

  await getMcpRegLock().withLock(async () => {
    const r = readMcpRegistry();
    delete r.servers[ref];
    writeMcpRegistry(r);
  });

  await getManifestLock().withLock(async () => {
    writeManifest(readManifest().filter((e) => !(e.kind === 'mcp' && e.ref === ref)));
  });
}

export async function deleteColdEntry(kind: 'skill' | 'mcp', ref: string): Promise<void> {
  if (kind === 'skill') {
    const coldPath = join(resolveColdStorageDir(), 'skills', ref);
    if (existsSync(coldPath)) {
      rmSync(coldPath, { recursive: true, force: true });
    }
  } else {
    await getMcpRegLock().withLock(async () => {
      const reg = readMcpRegistry();
      delete reg.servers[ref];
      writeMcpRegistry(reg);
    });
  }

  await getManifestLock().withLock(async () => {
    writeManifest(readManifest().filter((e) => !(e.kind === kind && e.ref === ref)));
  });
}

export function getColdManifest(): ColdManifestEntry[] {
  return readManifest();
}
