import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { FileLock } from './filelock';
import { detectPlaintextSecret } from './secret-detect';
import {
  mcpInventoryIdentity,
  mcpPlacementIdentity,
  type CapScope,
  type CodexMcpDiscoveryDiagnostics,
  type McpConfigScanIssue,
  type McpInventoryItem,
  type McpServerDef,
} from './types';

export const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

interface Etag {
  mtime: number;
  sha256: string;
}

export interface CodexMcpMutationOpts {
  ts: string;
  backupDir: string;
  configPath?: string;
  maxRetries?: number;
  skipVerify?: boolean;
}

export interface CodexMcpWriteOpts extends CodexMcpMutationOpts {
  targetDir?: string;
  projectDir?: string;
}

function parseToml(content: string): TomlTable {
  try {
    return Bun.TOML.parse(content) as TomlTable;
  } catch {
    throw new Error('Invalid TOML in Codex config.toml');
  }
}

function captureEtag(filePath: string): Etag | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    return {
      mtime: statSync(filePath).mtimeMs,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  } catch {
    return null;
  }
}

function etagEqual(a: Etag | null, b: Etag | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtime === b.mtime && a.sha256 === b.sha256;
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  let mode = 0o600;
  if (existsSync(filePath)) {
    try { mode = statSync(filePath).mode & 0o777; } catch { /* best effort */ }
  }
  const fd = openSync(tmpPath, 'w', mode);
  try {
    writeSync(fd, Buffer.from(content, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  try {
    const parentFd = openSync(dirname(filePath), 'r');
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch { /* not supported by every filesystem */ }
}

export function backupCodexConfig(configPath: string, backupDir: string, ts: string): void {
  if (!existsSync(configPath)) return;
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(
    join(backupDir, `config.toml.${ts}.bak`),
    readFileSync(configPath, 'utf8'),
    'utf8',
  );
}

function asTable(value: TomlValue | undefined): TomlTable | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TomlTable
    : undefined;
}

function asStringMap(value: TomlValue | undefined): Record<string, string> | undefined {
  const table = asTable(value);
  if (!table) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(table)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

function asStringArray(value: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value as string[];
}

function codexRawToDef(raw: TomlTable): McpServerDef {
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const envVars = Array.isArray(raw.env_vars)
    ? raw.env_vars.filter((item): item is string | { name: string; source?: 'local' | 'remote' } => {
        if (typeof item === 'string') return true;
        const table = asTable(item);
        return typeof table?.name === 'string' &&
          (table.source === undefined || table.source === 'local' || table.source === 'remote');
      }).map((item) => typeof item === 'string' ? item : {
        name: String(item.name),
        ...(item.source ? { source: item.source } : {}),
      })
    : undefined;
  return {
    type: command ? 'stdio' : url ? 'http' : undefined,
    command,
    args: asStringArray(raw.args),
    env: asStringMap(raw.env),
    envVars,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    url,
    headers: asStringMap(raw.http_headers),
    bearerTokenEnvVar:
      typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : undefined,
    envHttpHeaders: asStringMap(raw.env_http_headers),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    required: typeof raw.required === 'boolean' ? raw.required : undefined,
    enabledTools: asStringArray(raw.enabled_tools),
    disabledTools: asStringArray(raw.disabled_tools),
    startupTimeoutSec:
      typeof raw.startup_timeout_sec === 'number' ? raw.startup_timeout_sec : undefined,
    toolTimeoutSec: typeof raw.tool_timeout_sec === 'number' ? raw.tool_timeout_sec : undefined,
    codexRaw: raw,
  };
}

function codexDefToRaw(def: McpServerDef): TomlTable {
  const existing = asTable(def.codexRaw as TomlValue | undefined);
  const raw: TomlTable = existing ? { ...existing } : {};
  delete raw.type;

  const set = (key: string, value: TomlValue | undefined): void => {
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  };
  set('command', def.command);
  set('args', def.args);
  set('env', def.env);
  set('env_vars', def.envVars as TomlValue | undefined);
  set('cwd', def.cwd);
  set('url', def.url);
  set('http_headers', def.headers);
  set('bearer_token_env_var', def.bearerTokenEnvVar);
  set('env_http_headers', def.envHttpHeaders);
  set('enabled', def.enabled);
  set('required', def.required);
  set('enabled_tools', def.enabledTools);
  set('disabled_tools', def.disabledTools);
  set('startup_timeout_sec', def.startupTimeoutSec);
  set('tool_timeout_sec', def.toolTimeoutSec);
  return raw;
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(', ')}]`;
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${quoteKey(key)} = ${formatTomlValue(item)}`)
    .join(', ')} }`;
}

function serializeServer(name: string, def: McpServerDef): string {
  const raw = codexDefToRaw(def);
  const lines = [`[mcp_servers.${JSON.stringify(name)}]`];
  for (const [key, value] of Object.entries(raw)) {
    lines.push(`${quoteKey(key)} = ${formatTomlValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseDottedPath(input: string): string[] | null {
  const parts: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = (): boolean => {
    const trimmed = token.trim();
    token = '';
    if (!trimmed) return false;
    if (trimmed.startsWith('"')) {
      try { parts.push(JSON.parse(trimmed) as string); } catch { return false; }
    } else if (trimmed.startsWith("'")) {
      if (!trimmed.endsWith("'")) return false;
      parts.push(trimmed.slice(1, -1));
    } else {
      parts.push(trimmed);
    }
    return true;
  };

  for (const char of input) {
    if (quote === '"' && escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      token += char;
      escaped = true;
      continue;
    }
    if (quote) {
      token += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      token += char;
    } else if (char === '.') {
      if (!push()) return null;
    } else {
      token += char;
    }
  }
  return push() ? parts : null;
}

function tablePath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 1; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') return parseDottedPath(trimmed.slice(1, i));
  }
  return null;
}

function isServerPath(path: string[] | null, name: string): boolean {
  return Boolean(path && path[0] === 'mcp_servers' && path[1] === name);
}

/** Replace only one server's table(s); all non-target TOML remains byte-for-byte intact. */
export function applyCodexServerMutation(
  content: string,
  name: string,
  def: McpServerDef | null,
): string {
  parseToml(content || '');
  const lines = content.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let found = false;
  let inserted = false;

  for (let i = 0; i < lines.length;) {
    const path = tablePath(lines[i]);
    if (!isServerPath(path, name)) {
      output.push(lines[i]);
      i++;
      continue;
    }

    found = true;
    if (!inserted && def) {
      output.push(serializeServer(name, def));
      inserted = true;
    }
    i++;
    while (i < lines.length && tablePath(lines[i]) === null) i++;
  }

  if (!found && def) {
    const parsed = parseToml(content || '');
    const servers = asTable(parsed.mcp_servers);
    if (servers && Object.hasOwn(servers, name)) {
      throw new Error(`Codex MCP server "${name}" uses an unsupported inline TOML layout`);
    }
    const current = output.join('');
    if (current && !current.endsWith('\n')) output.push('\n');
    if (current.trim()) output.push('\n');
    output.push(serializeServer(name, def));
  }

  const result = output.join('');
  parseToml(result || '');
  return result;
}

function readServer(configPath: string, name: string): McpServerDef | null {
  if (!existsSync(configPath)) return null;
  const parsed = parseToml(readFileSync(configPath, 'utf8'));
  const raw = asTable(asTable(parsed.mcp_servers)?.[name]);
  return raw ? codexRawToDef(raw) : null;
}

const configLocks = new Map<string, FileLock>();

function configLock(filePath: string): FileLock {
  let lock = configLocks.get(filePath);
  if (!lock) {
    lock = new FileLock(`${filePath}.lock`);
    configLocks.set(filePath, lock);
  }
  return lock;
}

export async function safeMutateCodexConfig(
  name: string,
  mutator: (current: McpServerDef | null) => McpServerDef | null,
  opts: CodexMcpMutationOpts,
): Promise<{ before: string; after: string }> {
  const filePath = opts.configPath ?? CODEX_CONFIG_PATH;
  const maxRetries = opts.maxRetries ?? 5;
  let before = '';
  let after = '';

  await configLock(filePath).withLock(async () => {
    backupCodexConfig(filePath, opts.backupDir, opts.ts);
    before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    let currentContent = before;
    let currentEtag = captureEtag(filePath);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const parsed = parseToml(currentContent || '');
      const raw = asTable(asTable(parsed.mcp_servers)?.[name]);
      const next = mutator(raw ? codexRawToDef(raw) : null);
      const nextContent = applyCodexServerMutation(currentContent, name, next);

      if (!etagEqual(currentEtag, captureEtag(filePath))) {
        if (attempt >= maxRetries) {
          throw Object.assign(
            new Error(
              'Concurrent write conflict: another process modified Codex config.toml. ' +
                'Max retries exceeded — apply aborted.',
            ),
            { code: 'CONFLICT_409' },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        currentContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
        currentEtag = captureEtag(filePath);
        continue;
      }

      atomicWrite(filePath, nextContent);
      after = readFileSync(filePath, 'utf8');
      if (!opts.skipVerify) {
        const actual = readServer(filePath, name);
        const expectedRaw = next ? codexDefToRaw(next) : null;
        const actualRaw = actual ? codexDefToRaw(actual) : null;
        if (JSON.stringify(actualRaw) !== JSON.stringify(expectedRaw)) {
          const backupPath = join(opts.backupDir, `config.toml.${opts.ts}.bak`);
          if (existsSync(backupPath)) atomicWrite(filePath, readFileSync(backupPath, 'utf8'));
          throw new Error(
            'Post-write verification failed for Codex config.toml. Rolled back from backup.',
          );
        }
      }
      return;
    }
  });

  return { before, after };
}

export function codexConfigPathForScope(
  scope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
): string {
  if (scope === 'user') return opts.configPath ?? CODEX_CONFIG_PATH;
  const dir = scope === 'project' ? opts.projectDir ?? opts.targetDir : opts.targetDir;
  if (!dir) throw new Error(`${scope === 'project' ? 'projectDir' : 'targetDir'} required`);
  return join(dir, '.codex', 'config.toml');
}

export async function copyCodexMcp(
  name: string,
  def: McpServerDef,
  toScope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
  forceSecret = false,
): Promise<{ before: string; after: string; secretWarning?: boolean }> {
  if (toScope === 'project' && !forceSecret && detectPlaintextSecret(def)) {
    return { before: '', after: '', secretWarning: true };
  }
  return safeMutateCodexConfig(name, () => def, {
    ...opts,
    configPath: codexConfigPathForScope(toScope, opts),
  });
}

export async function removeCodexMcp(
  name: string,
  scope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
): Promise<{ before: string; after: string }> {
  return safeMutateCodexConfig(name, () => null, {
    ...opts,
    configPath: codexConfigPathForScope(scope, opts),
  });
}

export async function moveCodexMcp(
  name: string,
  def: McpServerDef,
  fromScope: 'user' | 'local' | 'project',
  fromDir: string | undefined,
  toScope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
  forceSecret = false,
): Promise<{ before: string; after: string; secretWarning?: boolean }> {
  if (toScope === 'project' && !forceSecret && detectPlaintextSecret(def)) {
    return { before: '', after: '', secretWarning: true };
  }
  const sourceOpts: CodexMcpWriteOpts = {
    ...opts,
    targetDir: fromScope === 'local' ? fromDir : opts.targetDir,
    projectDir: fromScope === 'project' ? fromDir : opts.projectDir,
  };
  const sourcePath = codexConfigPathForScope(fromScope, sourceOpts);
  const targetPath = codexConfigPathForScope(toScope, opts);
  if (sourcePath === targetPath) return { before: '', after: existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '' };

  const copied = await copyCodexMcp(name, def, toScope, opts, true);
  try {
    await removeCodexMcp(name, fromScope, {
      ...sourceOpts,
      // Both files are named config.toml; keep their backups from overwriting each other.
      ts: `${opts.ts}.source`,
    });
    return copied;
  } catch (error) {
    const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
    if (current !== copied.after) {
      throw Object.assign(
        new Error('Codex move failed and destination changed concurrently; automatic rollback was not safe.'),
        { code: 'CONFLICT_409', cause: error },
      );
    }
    if (copied.before === '') rmSync(targetPath, { force: true });
    else atomicWrite(targetPath, copied.before);
    throw error;
  }
}

export interface CodexMcpPreviewChange {
  filePath: string;
  isProjectFile: boolean;
  before: string;
  after: string;
}

function previewCodexAtPath(
  filePath: string,
  name: string,
  def: McpServerDef | null,
): CodexMcpPreviewChange {
  const before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  return {
    filePath,
    isProjectFile: filePath !== CODEX_CONFIG_PATH,
    before,
    after: applyCodexServerMutation(before, name, def),
  };
}

export function previewCopyCodexMcp(
  name: string,
  def: McpServerDef,
  toScope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
): CodexMcpPreviewChange[] {
  return [previewCodexAtPath(codexConfigPathForScope(toScope, opts), name, def)];
}

export function previewRemoveCodexMcp(
  name: string,
  scope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
): CodexMcpPreviewChange[] {
  return [previewCodexAtPath(codexConfigPathForScope(scope, opts), name, null)];
}

export function previewMoveCodexMcp(
  name: string,
  def: McpServerDef,
  fromScope: 'user' | 'local' | 'project',
  fromDir: string | undefined,
  toScope: 'user' | 'local' | 'project',
  opts: CodexMcpWriteOpts,
): CodexMcpPreviewChange[] {
  const sourceOpts = {
    ...opts,
    targetDir: fromScope === 'local' ? fromDir : opts.targetDir,
    projectDir: fromScope === 'project' ? fromDir : opts.projectDir,
  };
  const sourcePath = codexConfigPathForScope(fromScope, sourceOpts);
  const targetPath = codexConfigPathForScope(toScope, opts);
  if (sourcePath === targetPath) return [previewCodexAtPath(sourcePath, name, def)];
  return [
    previewCodexAtPath(targetPath, name, def),
    previewCodexAtPath(sourcePath, name, null),
  ];
}

export interface CodexProjectTarget {
  dir: string;
  scope?: Extract<CapScope, 'local' | 'project'>;
}

export interface CodexMcpDiscoveryResult {
  items: McpInventoryItem[];
  diagnostics: CodexMcpDiscoveryDiagnostics;
}

interface CodexConfigLayer {
  path: string;
  dir?: string;
  scope: 'user' | 'local' | 'project';
  configLayer: 'user' | 'project' | 'subdirectory';
  precedence: number;
  servers: TomlTable;
}

function findCodexProjectRoot(targetDir: string): string {
  let current = resolve(targetDir);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(targetDir);
    current = parent;
  }
}

function directoriesFromRoot(rootDir: string, targetDir: string): string[] {
  const root = resolve(rootDir);
  const target = resolve(targetDir);
  const rel = relative(root, target);
  if (!rel) return [root];
  if (rel.startsWith('..')) return [target];
  const result = [root];
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    result.push(current);
  }
  return result;
}

function emptyCodexDiagnostics(): CodexMcpDiscoveryDiagnostics {
  return {
    candidateConfigPaths: [],
    scannedConfigPaths: [],
    issues: [],
    projectTrust: { required: false, status: 'unknown', configPaths: [] },
  };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function readCodexLayer(
  path: string,
  diagnostics: CodexMcpDiscoveryDiagnostics,
): TomlTable | null {
  pushUnique(diagnostics.candidateConfigPaths, path);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseToml(readFileSync(path, 'utf8'));
    pushUnique(diagnostics.scannedConfigPaths, path);
    return asTable(parsed.mcp_servers) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read Codex config';
    const issue: McpConfigScanIssue = {
      runtime: 'codex',
      path,
      code: message.includes('Invalid TOML') ? 'invalid-config' : 'read-error',
      message,
    };
    diagnostics.issues.push(issue);
    return null;
  }
}

/**
 * Discover the effective Codex MCP config chain for every registered directory.
 * Project trust is reported as required/unknown; this reader never guesses or
 * suppresses a project layer based on inferred trust state.
 */
export async function discoverCodexMcpInventory(
  projectTargets: CodexProjectTarget[] = [],
  userConfigPath: string = CODEX_CONFIG_PATH,
): Promise<CodexMcpDiscoveryResult> {
  const diagnostics = emptyCodexDiagnostics();
  const serverMap = new Map<
    string,
    { def: McpServerDef; placements: McpInventoryItem['placements'] }
  >();
  const userServers = readCodexLayer(userConfigPath, diagnostics) ?? {};

  const addPlacement = (
    name: string,
    def: McpServerDef,
    layer: CodexConfigLayer,
    appliesToDir: string | undefined,
    effective: boolean,
    overriddenBy: string | undefined,
  ): void => {
    const entry = serverMap.get(name) ?? { def, placements: [] };
    if (effective) entry.def = def;
    const dedupeKey = `${layer.path}\0${appliesToDir ?? ''}\0${name}`;
    if (!entry.placements.some((placement) =>
      `${placement.location}\0${placement.appliesToDir ?? ''}\0${name}` === dedupeKey)) {
      entry.placements.push({
        identity: mcpPlacementIdentity('codex', name, layer.path, appliesToDir),
        runtime: 'codex',
        scope: layer.scope,
        location: layer.path,
        dir: layer.dir,
        appliesToDir,
        configLayer: layer.configLayer,
        precedence: layer.precedence,
        effective,
        overriddenBy,
        definition: def,
        projectTrust: layer.configLayer === 'user'
          ? 'not-required'
          : 'required-status-unknown',
        alwaysLoad: false,
        hasPlaintextSecret: detectPlaintextSecret(def),
        managed: false,
      });
    }
    serverMap.set(name, entry);
  };

  const targets = [...projectTargets]
    .map((target) => ({ ...target, dir: resolve(target.dir) }))
    .filter((target, index, all) => all.findIndex((item) => item.dir === target.dir) === index)
    .sort((a, b) => a.dir.localeCompare(b.dir));

  if (targets.length === 0) {
    const userLayer: CodexConfigLayer = {
      path: userConfigPath,
      scope: 'user',
      configLayer: 'user',
      precedence: 0,
      servers: userServers,
    };
    for (const [name, value] of Object.entries(userServers)) {
      const raw = asTable(value);
      if (raw) addPlacement(name, codexRawToDef(raw), userLayer, undefined, true, undefined);
    }
  }

  for (const target of targets) {
    try {
      const projectRoot = findCodexProjectRoot(target.dir);
      const chainDirs = directoriesFromRoot(projectRoot, target.dir);
      const layers: CodexConfigLayer[] = [{
        path: userConfigPath,
        scope: 'user',
        configLayer: 'user',
        precedence: 0,
        servers: userServers,
      }];

      chainDirs.forEach((dir, index) => {
        const path = join(dir, '.codex', 'config.toml');
        if (existsSync(path)) {
          pushUnique(diagnostics.projectTrust.configPaths, path);
          diagnostics.projectTrust.required = true;
        }
        const servers = readCodexLayer(path, diagnostics);
        if (servers) {
          layers.push({
            path,
            dir,
            scope: index === 0 ? 'project' : 'local',
            configLayer: index === 0 ? 'project' : 'subdirectory',
            precedence: index + 1,
            servers,
          });
        }
      });

      const names = new Set<string>();
      for (const layer of layers) {
        for (const [name, value] of Object.entries(layer.servers)) {
          if (asTable(value)) names.add(name);
        }
      }

      for (const name of names) {
        const definingLayers = layers.filter((layer) => asTable(layer.servers[name]));
        definingLayers.forEach((layer, index) => {
          const raw = asTable(layer.servers[name]);
          if (!raw) return;
          const next = definingLayers[index + 1];
          addPlacement(
            name,
            codexRawToDef(raw),
            layer,
            target.dir,
            index === definingLayers.length - 1,
            next?.path,
          );
        });
      }
    } catch (error) {
      diagnostics.issues.push({
        runtime: 'codex',
        path: target.dir,
        code: 'scan-failed',
        message: error instanceof Error ? error.message : 'Codex directory scan failed',
      });
    }
  }

  const items = [...serverMap.entries()].map(([name, entry]) => ({
    identity: mcpInventoryIdentity('codex', name),
    runtime: 'codex' as const,
    name,
    def: entry.def,
    placements: entry.placements.sort((a, b) =>
      (a.appliesToDir ?? '').localeCompare(b.appliesToDir ?? '') ||
      (a.precedence ?? 0) - (b.precedence ?? 0)),
    status: entry.def.enabled === false ? 'unknown' as const : 'active' as const,
    toolCount: entry.def.enabledTools?.length,
    preloadReason: null,
  })).sort((a, b) => a.identity.localeCompare(b.identity));

  return { items, diagnostics };
}

export async function readCodexMcpInventory(
  projectTargets: CodexProjectTarget[] = [],
  userConfigPath: string = CODEX_CONFIG_PATH,
): Promise<McpInventoryItem[]> {
  return (await discoverCodexMcpInventory(projectTargets, userConfigPath)).items;
}
