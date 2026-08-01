import { useCallback, useEffect, useState } from 'react';
import type {
  McpAlwaysLoadRequest,
  McpCopyRequest,
  McpDeleteRequest,
  McpInventoryItem,
  McpMoveRequest,
  McpRuntime,
  McpServerDef,
  DiscoveredSkill,
  SkillVisibility,
  ContextDiagnostics,
  ColdManifestEntry,
  ColdEntryView,
} from '../../../src/core/types';

export type { ColdManifestEntry, ColdEntryView };

const BASE_URL = '/api';

// ─── Mutation types ──────────────────────────────────────────────

export type SkillOverrideValue = 'on' | 'name-only' | 'user-invocable-only' | 'off';

export interface SkillVisibilityPatch {
  scope?: 'user' | 'project' | 'local';
  projectDir?: string;
  override?: SkillOverrideValue | null;
  disableModelInvocation?: boolean;
}

export type McpAlwaysLoadPatch = McpAlwaysLoadRequest;

export interface VisibilityChange {
  filePath: string;
  isProjectFile: boolean;
  before: string;
  after: string;
}

export interface VisibilityPreviewResult {
  preview: true;
  changes: VisibilityChange[];
}

export type McpCopyBody = McpCopyRequest;

export type McpMoveBody = McpMoveRequest;

export type McpDeleteBody = McpDeleteRequest;

export interface McpWriteResult {
  ok: boolean;
  before: string;
  after: string;
  secretWarning?: boolean;
  message?: string;
}

export type McpMutationPreviewResult = VisibilityPreviewResult & {
  secretWarning?: boolean;
  message?: string;
};

async function apiPost(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function apiDelete(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function handleWriteResponse(res: Response): Promise<McpWriteResult> {
  const data = (await res.json()) as McpWriteResult & { error?: string };
  if (!res.ok && !data.secretWarning) {
    throw new Error(data.error ?? res.statusText);
  }
  return data;
}

export async function copyMcpServer(name: string, body: McpCopyBody): Promise<McpWriteResult> {
  const res = await apiPost(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}/copy`, body);
  return handleWriteResponse(res);
}

export async function previewCopyMcpServer(name: string, body: McpCopyBody): Promise<McpMutationPreviewResult> {
  const res = await apiPost(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}/copy?preview=1`, body);
  return handleWriteResponse(res) as unknown as Promise<McpMutationPreviewResult>;
}

export async function moveMcpServer(name: string, body: McpMoveBody): Promise<McpWriteResult> {
  const res = await apiPost(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}/move`, body);
  return handleWriteResponse(res);
}

export async function previewMoveMcpServer(name: string, body: McpMoveBody): Promise<McpMutationPreviewResult> {
  const res = await apiPost(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}/move?preview=1`, body);
  return handleWriteResponse(res) as unknown as Promise<McpMutationPreviewResult>;
}

export async function removeMcpServer(name: string, body: McpDeleteBody): Promise<McpWriteResult> {
  const res = await apiDelete(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}`, body);
  return handleWriteResponse(res);
}

export async function previewRemoveMcpServer(name: string, body: McpDeleteBody): Promise<McpMutationPreviewResult> {
  const res = await apiDelete(`${BASE_URL}/scope/mcp/${encodeURIComponent(name)}?preview=1`, body);
  return handleWriteResponse(res) as unknown as Promise<McpMutationPreviewResult>;
}

async function apiPatch(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res;
}

export async function previewSkillVisibility(
  skillId: string,
  patch: SkillVisibilityPatch,
): Promise<VisibilityPreviewResult> {
  const res = await apiPatch(`${BASE_URL}/scope/skill/${encodeURIComponent(skillId)}/visibility?preview=1`, patch);
  return res.json() as Promise<VisibilityPreviewResult>;
}

export async function patchSkillVisibility(
  skillId: string,
  patch: SkillVisibilityPatch,
): Promise<void> {
  await apiPatch(`${BASE_URL}/scope/skill/${encodeURIComponent(skillId)}/visibility`, patch);
}

export async function previewMcpAlwaysLoad(
  mcpName: string,
  patch: McpAlwaysLoadPatch,
): Promise<VisibilityPreviewResult> {
  const res = await apiPatch(`${BASE_URL}/scope/mcp/${encodeURIComponent(mcpName)}/always-load?preview=1`, patch);
  return res.json() as Promise<VisibilityPreviewResult>;
}

export async function patchMcpAlwaysLoad(
  mcpName: string,
  patch: McpAlwaysLoadPatch,
): Promise<void> {
  await apiPatch(`${BASE_URL}/scope/mcp/${encodeURIComponent(mcpName)}/always-load`, patch);
}

export interface ScopeInventoryData {
  mcp: McpInventoryItem[];
  skills: (DiscoveredSkill & SkillVisibility)[];
  diagnostics: ContextDiagnostics;
}

async function fetchInventory(): Promise<ScopeInventoryData> {
  const res = await fetch(`${BASE_URL}/scope/inventory`);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<ScopeInventoryData>;
}

export interface UseScopeInventoryResult {
  data: ScopeInventoryData | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useScopeInventory(enabled: boolean): UseScopeInventoryResult {
  const [data, setData] = useState<ScopeInventoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchInventory());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scope inventory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { data, loading, error, refresh };
}

// ─── Skill Move / Remove ──────────────────────────────────────

export interface MoveSkillBody {
  targetRootId?: string;
  placementTargetId?: string;
}

export async function moveSkillApi(skillId: string, body: MoveSkillBody): Promise<void> {
  const res = await fetch(`${BASE_URL}/scope/skill/${encodeURIComponent(skillId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
}

export async function removeSkillApi(skillId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/scope/skill/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
}

// ─── Cold Storage API ─────────────────────────────────────────

export async function freezeSkillApi(skillId: string): Promise<ColdManifestEntry> {
  const res = await fetch(`${BASE_URL}/scope/cold/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'skill', skillId }),
  });
  const data = (await res.json()) as { error?: string; entry?: ColdManifestEntry };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data.entry!;
}

export async function freezeMcpApi(
  mcpName: string,
  scope: string,
  fromDir?: string,
  runtime: McpRuntime = 'claude',
  placementIdentity?: string,
): Promise<ColdManifestEntry> {
  const res = await fetch(`${BASE_URL}/scope/cold/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mcp', mcpName, scope, fromDir, runtime, placementIdentity }),
  });
  const data = (await res.json()) as { error?: string; entry?: ColdManifestEntry };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data.entry!;
}

export async function previewFreezeMcpApi(
  mcpName: string,
  scope: string,
  fromDir: string | undefined,
  runtime: McpRuntime,
  placementIdentity: string,
): Promise<McpMutationPreviewResult> {
  const res = await apiPost(`${BASE_URL}/scope/cold/freeze?preview=1`, {
    kind: 'mcp', mcpName, scope, fromDir, runtime, placementIdentity,
  });
  return handleWriteResponse(res) as unknown as Promise<McpMutationPreviewResult>;
}

export async function restoreSkillColdApi(ref: string, targetRootId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/scope/cold/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'skill', ref, targetRootId }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
}

export async function restoreMcpColdApi(
  ref: string,
  toScope: string,
  targetDir?: string,
  projectDir?: string,
  runtime?: McpRuntime,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/scope/cold/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mcp', ref, toScope, targetDir, projectDir, runtime }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
}

export async function previewRestoreMcpColdApi(
  ref: string,
  toScope: string,
  targetDir?: string,
  projectDir?: string,
  runtime?: McpRuntime,
): Promise<McpMutationPreviewResult> {
  const res = await apiPost(`${BASE_URL}/scope/cold/restore?preview=1`, {
    kind: 'mcp', ref, toScope, targetDir, projectDir, runtime,
  });
  return handleWriteResponse(res) as unknown as Promise<McpMutationPreviewResult>;
}

export interface ColdEntryDetail {
  entry: ColdManifestEntry;
  /** skill only — absolute path of the frozen SKILL.md */
  filePath?: string;
  /** skill only — SKILL.md content; absent when the frozen folder has none */
  content?: string;
  /** mcp only — server definition kept in the cold registry */
  def?: McpServerDef;
}

export async function fetchColdEntryDetail(
  kind: 'skill' | 'mcp',
  ref: string,
): Promise<ColdEntryDetail> {
  const res = await fetch(`${BASE_URL}/scope/cold/${kind}/${encodeURIComponent(ref)}`);
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
  return res.json() as Promise<ColdEntryDetail>;
}

export async function deleteColdApi(kind: 'skill' | 'mcp', ref: string): Promise<void> {
  const res = await fetch(
    `${BASE_URL}/scope/cold/${kind}/${encodeURIComponent(ref)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
}

async function fetchColdManifest(): Promise<ColdEntryView[]> {
  const res = await fetch(`${BASE_URL}/scope/cold`);
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? res.statusText);
  }
  return res.json() as Promise<ColdEntryView[]>;
}

export interface UseColdStorageResult {
  entries: ColdEntryView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useColdStorage(enabled: boolean): UseColdStorageResult {
  const [entries, setEntries] = useState<ColdEntryView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchColdManifest());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cold storage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { entries, loading, error, refresh };
}
