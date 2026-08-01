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
import { join, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { mcpPlacementIdentity, type DiscoveredSkill, type CapScope, type McpPlacement, type McpRuntime, type McpServerDef, type ColdManifestEntry, type ColdEntryView } from './types';
import { parseFrontmatter } from './skill-scanner';
import { FileLock } from './filelock';
import { resolveKanbanDataDir } from './data-dir';
import {
  safeMutateClaudeJson,
  CLAUDE_JSON_PATH,
  backupClaudeJson,
  copyMcp,
} from './mcp-config-store';
import { copyCodexMcp, removeCodexMcp } from './codex-mcp-config';

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
  runtime?: McpRuntime;
  originScope: CapScope;
  frozenAt: string;
  hash: string;
  sourcePlacement?: ColdManifestEntry['sourcePlacement'];
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
    return (JSON.parse(readFileSync(p, 'utf8')) as ColdManifestEntry[]).map((entry) =>
      entry.kind === 'mcp' && !entry.runtime
        ? { ...entry, runtime: entry.ref.startsWith('codex/') ? 'codex' : 'claude' }
        : entry,
    );
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
  opts: { ts: string; runtime?: McpRuntime; claudeJsonPath?: string; codexConfigPath?: string; sourcePlacement?: McpPlacement },
): Promise<ColdManifestEntry> {
  const runtime = opts.runtime ?? 'claude';
  const ref = runtime === 'claude' ? name : `${runtime}/${name}`;
  const hash = hashDef(def);
  const backupDir = join(resolveColdStorageDir(), 'backups');
  const filePath = opts.claudeJsonPath ?? CLAUDE_JSON_PATH;

  // Save to MCP registry first
  await getMcpRegLock().withLock(async () => {
    const reg = readMcpRegistry();
    const location = opts.sourcePlacement?.location ?? (runtime === 'codex'
      ? opts.codexConfigPath ?? (fromDir ? join(fromDir, '.codex', 'config.toml') : join(dirname(filePath), '.codex', 'config.toml'))
      : scope === 'project' && fromDir ? join(fromDir, '.mcp.json') : filePath);
    const sourcePlacement = {
      identity: opts.sourcePlacement?.identity ?? mcpPlacementIdentity(runtime, name, location, opts.sourcePlacement?.appliesToDir ?? fromDir),
      runtime,
      scope,
      location,
      ...(fromDir ? { dir: fromDir } : {}),
      ...(opts.sourcePlacement?.appliesToDir ? { appliesToDir: opts.sourcePlacement.appliesToDir } : {}),
    };
    reg.servers[ref] = { def, runtime, originScope: scope, frozenAt: new Date().toISOString(), hash, sourcePlacement };
    writeMcpRegistry(reg);
  });

  try {
  // Preserve the established Claude CAS-only freeze path exactly. Codex is additive.
  if (runtime === 'claude' && scope === 'user') {
    backupClaudeJson(filePath, backupDir, opts.ts);
    await safeMutateClaudeJson(
      (obj) => {
        const servers = { ...(obj.mcpServers ?? {}) };
        delete servers[name];
        return { ...obj, mcpServers: servers };
      },
      { ts: opts.ts, backupDir, claudeJsonPath: opts.claudeJsonPath },
    );
  } else if (runtime === 'claude' && scope === 'local' && fromDir) {
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
  } else if (runtime === 'claude' && scope === 'project' && fromDir) {
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
  } else if (runtime === 'codex' && (scope === 'user' || scope === 'local' || scope === 'project')) {
    await removeCodexMcp(name, scope, {
      ts: opts.ts,
      backupDir,
      configPath: opts.codexConfigPath,
      targetDir: scope === 'local' ? fromDir : undefined,
      projectDir: scope === 'project' ? fromDir : undefined,
    });
  }
  } catch (error) {
    await getMcpRegLock().withLock(async () => {
      const reg = readMcpRegistry();
      delete reg.servers[ref];
      writeMcpRegistry(reg);
    });
    throw error;
  }

  const entry: ColdManifestEntry = {
    kind: 'mcp',
    ref,
    runtime,
    sourceScope: scope,
    sourcePath: scope === 'project' && fromDir
      ? join(fromDir, runtime === 'codex' ? '.codex/config.toml' : '.mcp.json')
      : runtime === 'codex' ? (opts.codexConfigPath ?? join(dirname(filePath), '.codex/config.toml')) : filePath,
    projectRoot: fromDir,
    sourcePlacement: readMcpRegistry().servers[ref]?.sourcePlacement,
    originalConfigJson: JSON.stringify(def),
    hash,
    createdAt: new Date().toISOString(),
    restorePolicy: 'any',
  };

  await getManifestLock().withLock(async () => {
    const entries = readManifest().filter((e) => !(e.kind === 'mcp' && e.ref === ref));
    entries.push(entry);
    writeManifest(entries);
  });

  return entry;
}

export async function restoreMcp(
  ref: string,
  toScope: 'user' | 'local' | 'project' | undefined,
  opts: {
    ts: string;
    runtime?: McpRuntime;
    targetDir?: string;
    projectDir?: string;
    claudeJsonPath?: string;
    codexConfigPath?: string;
  },
): Promise<void> {
  const reg = readMcpRegistry();
  const regEntry = reg.servers[ref];
  if (!regEntry) throw new Error(`Cold storage MCP not found: ${ref}`);
  const runtime = regEntry.runtime ?? (ref.startsWith('codex/') ? 'codex' : 'claude');
  if (opts.runtime && opts.runtime !== runtime) {
    throw Object.assign(new Error(`Cold MCP runtime is ${runtime}, not ${opts.runtime}`), { code: 'RUNTIME_MISMATCH' });
  }
  const manifestEntry = readManifest().find((entry) => entry.kind === 'mcp' && entry.ref === ref);
  const sourcePlacement = regEntry.sourcePlacement ?? manifestEntry?.sourcePlacement;
  const resolvedScope = toScope ?? (sourcePlacement?.scope !== 'cold'
    ? sourcePlacement?.scope : undefined) ?? regEntry.originScope;
  if (resolvedScope === 'cold') throw new Error('Original MCP placement is not writable');

  const backupDir = join(resolveColdStorageDir(), 'backups');
  const name = runtime === 'codex' && ref.startsWith('codex/') ? ref.slice('codex/'.length) : ref;
  if (runtime === 'claude') {
    await copyMcp(name, regEntry.def, resolvedScope, {
      ts: opts.ts,
      backupDir,
      targetDir: opts.targetDir ?? (resolvedScope === 'local' ? sourcePlacement?.dir : undefined),
      projectDir: opts.projectDir ?? (resolvedScope === 'project' ? sourcePlacement?.dir : undefined),
      claudeJsonPath: opts.claudeJsonPath,
    });
  } else {
    await copyCodexMcp(name, regEntry.def, resolvedScope, {
      ts: opts.ts,
      backupDir,
      targetDir: opts.targetDir ?? (resolvedScope === 'local' ? sourcePlacement?.dir : undefined),
      projectDir: opts.projectDir ?? (resolvedScope === 'project' ? sourcePlacement?.dir : undefined),
      configPath: opts.codexConfigPath,
    });
  }

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

/** One-line "what is this" for an MCP definition: the invocation or the endpoint. */
function summarizeMcpDef(def: McpServerDef): string | undefined {
  if (def.command) return [def.command, ...(def.args ?? [])].join(' ');
  if (typeof def.url === 'string') return def.url;
  return undefined;
}

function readColdMcpDef(ref: string, entry: ColdManifestEntry): McpServerDef | undefined {
  const registered = readMcpRegistry().servers[ref]?.def;
  if (registered) return registered;
  if (!entry.originalConfigJson) return undefined;
  try {
    return JSON.parse(entry.originalConfigJson) as McpServerDef;
  } catch {
    return undefined;
  }
}

/**
 * Manifest plus a human-readable summary per entry, so the Cold Storage list can
 * show what each frozen item actually is instead of a bare ref.
 */
export function getColdManifestView(): ColdEntryView[] {
  return readManifest().map((entry) => {
    if (entry.kind === 'skill') {
      const file = readColdSkillContent(entry.ref);
      return { ...entry, summary: file ? parseFrontmatter(file.content).description : undefined };
    }
    const def = readColdMcpDef(entry.ref, entry);
    return { ...entry, summary: def ? summarizeMcpDef(def) : undefined };
  });
}

/**
 * Read a frozen skill's SKILL.md straight from cold storage. The ref comes from
 * the manifest, but it is user-facing input on the API path — resolve it and
 * reject anything that escapes the cold `skills/` directory.
 */
export function readColdSkillContent(ref: string): { filePath: string; content: string } | null {
  const skillsRoot = join(resolveColdStorageDir(), 'skills');
  const skillDir = resolve(skillsRoot, ref);
  if (skillDir !== skillsRoot && !skillDir.startsWith(skillsRoot + sep)) return null;
  const filePath = join(skillDir, 'SKILL.md');
  if (!existsSync(filePath)) return null;
  try {
    return { filePath, content: readFileSync(filePath, 'utf8') };
  } catch {
    return null;
  }
}

export function getColdMcpEntry(ref: string): {
  def: McpServerDef;
  runtime: McpRuntime;
  originScope: CapScope;
  sourcePlacement?: ColdManifestEntry['sourcePlacement'];
} | null {
  const entry = readMcpRegistry().servers[ref];
  if (!entry) return null;
  return {
    def: entry.def,
    runtime: entry.runtime ?? (ref.startsWith('codex/') ? 'codex' : 'claude'),
    originScope: entry.originScope,
    sourcePlacement: entry.sourcePlacement ?? readManifest().find((item) => item.kind === 'mcp' && item.ref === ref)?.sourcePlacement,
  };
}
