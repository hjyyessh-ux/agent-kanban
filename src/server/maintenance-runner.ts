import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveKanbanDataDir } from '../core/data-dir';

export type MaintenanceState = 'idle' | 'running' | 'success' | 'fail';

export interface MaintenanceStatus {
  state: MaintenanceState;
  logPath: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  message?: string;
  repoRoot?: string;
  updatedAt: string;
}

export interface MaintenanceStartResult {
  started: true;
  pid: number;
  logPath: string;
  statusPath: string;
  repoRoot: string;
}

const LOG_FILENAME = 'maintenance-update.log';
const STATUS_FILENAME = 'maintenance-update-status.json';
const LAUNCHER_FILENAME = 'maintenance-update-runner.sh';
const PROJECT_PATH_FILENAME = 'daemon-project-path';

function paths() {
  const dataDir = resolveKanbanDataDir();
  return {
    dataDir,
    logPath: join(dataDir, LOG_FILENAME),
    statusPath: join(dataDir, STATUS_FILENAME),
    launcherPath: join(dataDir, LAUNCHER_FILENAME),
    projectPath: join(dataDir, PROJECT_PATH_FILENAME),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatusFile(statusPath: string, logPath: string): MaintenanceStatus {
  if (!existsSync(statusPath)) {
    return {
      state: 'idle',
      logPath,
      updatedAt: nowIso(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statusPath, 'utf-8')) as MaintenanceStatus;
    return {
      ...parsed,
      logPath: parsed.logPath || logPath,
      updatedAt: parsed.updatedAt || nowIso(),
    };
  } catch {
    return {
      state: 'fail',
      logPath,
      message: 'Maintenance status file is unreadable.',
      updatedAt: nowIso(),
    };
  }
}

function writeStatus(statusPath: string, status: MaintenanceStatus): void {
  writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

function resolveRepoRoot(projectPath: string): string {
  const envRoot = process.env.KANBAN_REPO_ROOT?.trim();
  if (envRoot) return envRoot;

  if (existsSync(projectPath)) {
    const recordedRoot = readFileSync(projectPath, 'utf-8').trim();
    if (recordedRoot) return recordedRoot;
  }

  return process.cwd();
}

function createLauncherScript(input: {
  repoRoot: string;
  installPath: string;
  restartPath: string;
  logPath: string;
  statusPath: string;
}): string {
  const repoRootJson = JSON.stringify(input.repoRoot);
  const logPathJson = JSON.stringify(input.logPath);
  const statusPathJson = JSON.stringify(input.statusPath);

  return `#!/usr/bin/env bash
set -u

REPO_ROOT=${shellQuote(input.repoRoot)}
INSTALL_SCRIPT=${shellQuote(input.installPath)}
RESTART_SCRIPT=${shellQuote(input.restartPath)}
LOG_PATH=${shellQuote(input.logPath)}
STATUS_PATH=${shellQuote(input.statusPath)}

write_status() {
  local state="$1"
  local exit_code="$2"
  local message="$3"
  local timestamp
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  cat > "$STATUS_PATH" <<JSON
{
  "state": "$state",
  "pid": $$,
  "startedAt": "$STARTED_AT",
  "finishedAt": "$timestamp",
  "exitCode": $exit_code,
  "message": "$message",
  "repoRoot": ${repoRootJson},
  "logPath": ${logPathJson},
  "updatedAt": "$timestamp"
}
JSON
}

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "$(dirname "$LOG_PATH")"
cat > "$STATUS_PATH" <<JSON
{
  "state": "running",
  "pid": $$,
  "startedAt": "$STARTED_AT",
  "message": "Build, install, and restart started.",
  "repoRoot": ${repoRootJson},
  "logPath": ${logPathJson},
  "updatedAt": "$STARTED_AT"
}
JSON

{
  echo ""
  echo "[$STARTED_AT] Starting Agent Kanban maintenance update"
  echo "Repo root: $REPO_ROOT"
  echo "Install script: $INSTALL_SCRIPT"
  echo "Restart script: $RESTART_SCRIPT"
  cd "$REPO_ROOT"
  bash "$INSTALL_SCRIPT"
  bash "$RESTART_SCRIPT" --yes
} >> "$LOG_PATH" 2>&1

exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  write_status "success" "$exit_code" "Build, install, and restart completed."
else
  write_status "fail" "$exit_code" "Build, install, or restart failed. Check the log."
fi

exit "$exit_code"
`;
}

export function getMaintenanceStatus(): MaintenanceStatus {
  const { statusPath, logPath } = paths();
  const status = readStatusFile(statusPath, logPath);

  if (status.state === 'running' && !isPidAlive(status.pid)) {
    const staleStatus: MaintenanceStatus = {
      ...status,
      state: 'fail',
      message: 'Maintenance process exited before writing a final status.',
      updatedAt: nowIso(),
    };
    writeStatus(statusPath, staleStatus);
    return staleStatus;
  }

  return status;
}

export function readMaintenanceLog(maxBytes = 120_000): { log: string; logPath: string } {
  const { logPath } = paths();
  if (!existsSync(logPath)) {
    return { log: '', logPath };
  }

  const content = readFileSync(logPath, 'utf-8');
  if (content.length <= maxBytes) {
    return { log: content, logPath };
  }

  return {
    log: content.slice(content.length - maxBytes),
    logPath,
  };
}

export function startApplyUpdateRestart(): MaintenanceStartResult {
  const { dataDir, logPath, statusPath, launcherPath, projectPath } = paths();
  mkdirSync(dataDir, { recursive: true });

  const currentStatus = getMaintenanceStatus();
  if (currentStatus.state === 'running') {
    throw new Error('Maintenance update is already running.');
  }

  const repoRoot = resolveRepoRoot(projectPath);
  const installPath = join(repoRoot, 'scripts', 'install.sh');
  const restartPath = join(repoRoot, 'scripts', 'restart-opencode-plugin.sh');

  if (!existsSync(installPath)) {
    throw new Error(`Install script not found: ${installPath}`);
  }
  if (!existsSync(restartPath)) {
    throw new Error(`Restart script not found: ${restartPath}`);
  }

  const launcher = createLauncherScript({
    repoRoot,
    installPath,
    restartPath,
    logPath,
    statusPath,
  });
  writeFileSync(launcherPath, launcher, { mode: 0o700 });

  const proc = Bun.spawn(['/bin/bash', launcherPath], {
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  proc.unref();

  const status: MaintenanceStatus = {
    state: 'running',
    pid: proc.pid,
    startedAt: nowIso(),
    message: 'Build, install, and restart started.',
    repoRoot,
    logPath,
    updatedAt: nowIso(),
  };
  writeStatus(statusPath, status);

  return {
    started: true,
    pid: proc.pid,
    logPath,
    statusPath,
    repoRoot,
  };
}
