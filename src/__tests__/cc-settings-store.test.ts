import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  readCcDiagnostics,
  computeSkillVisibility,
  computeToolSearchEffective,
  detectVertexOrProxy,
  detectRuntimeSupportsToolSearch,
  previewSkillOverride,
  setSkillOverride,
} from '../core/cc-settings-store';
import { withTempDir } from './setup';

// ── detectVertexOrProxy ──────────────────────────────────────────

describe('detectVertexOrProxy', () => {
  test('returns false when ANTHROPIC_BASE_URL is unset', () => {
    expect(detectVertexOrProxy({})).toBe(false);
  });

  test('returns false when pointing to anthropic.com', () => {
    expect(detectVertexOrProxy({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false);
  });

  test('returns true when pointing to googleapis.com', () => {
    expect(
      detectVertexOrProxy({
        ANTHROPIC_BASE_URL: 'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj',
      }),
    ).toBe(true);
  });

  test('returns true when pointing to a custom proxy', () => {
    expect(detectVertexOrProxy({ ANTHROPIC_BASE_URL: 'https://my-proxy.example.com/v1' })).toBe(true);
  });
});

// ── detectRuntimeSupportsToolSearch ──────────────────────────────

describe('detectRuntimeSupportsToolSearch', () => {
  test('returns true when no model set', () => {
    expect(detectRuntimeSupportsToolSearch({})).toBe(true);
  });

  test('returns true for sonnet model', () => {
    expect(
      detectRuntimeSupportsToolSearch({ ANTHROPIC_MODEL: 'claude-sonnet-4-6' }),
    ).toBe(true);
  });

  test('returns false for haiku model', () => {
    expect(
      detectRuntimeSupportsToolSearch({ ANTHROPIC_MODEL: 'claude-haiku-4-5' }),
    ).toBe(false);
  });

  test('returns false for haiku via CLAUDE_MODEL', () => {
    expect(
      detectRuntimeSupportsToolSearch({ CLAUDE_MODEL: 'claude-haiku-4-5-20251001' }),
    ).toBe(false);
  });
});

// ── computeToolSearchEffective ───────────────────────────────────

describe('computeToolSearchEffective', () => {
  test('returns false when ENABLE_TOOL_SEARCH=false', () => {
    expect(
      computeToolSearchEffective({
        enableToolSearch: 'false',
        runtimeSupportsToolSearch: true,
        isVertexOrProxy: false,
      }),
    ).toBe(false);
  });

  test('returns false when runtime does not support tool search', () => {
    expect(
      computeToolSearchEffective({
        enableToolSearch: 'unset',
        runtimeSupportsToolSearch: false,
        isVertexOrProxy: false,
      }),
    ).toBe(false);
  });

  test('returns false on Vertex with unset ENABLE_TOOL_SEARCH', () => {
    expect(
      computeToolSearchEffective({
        enableToolSearch: 'unset',
        runtimeSupportsToolSearch: true,
        isVertexOrProxy: true,
      }),
    ).toBe(false);
  });

  test('returns true on Vertex with ENABLE_TOOL_SEARCH=true', () => {
    expect(
      computeToolSearchEffective({
        enableToolSearch: 'true',
        runtimeSupportsToolSearch: true,
        isVertexOrProxy: true,
      }),
    ).toBe(true);
  });

  test('returns true with normal setup and unset env', () => {
    expect(
      computeToolSearchEffective({
        enableToolSearch: 'unset',
        runtimeSupportsToolSearch: true,
        isVertexOrProxy: false,
      }),
    ).toBe(true);
  });
});

// ── computeSkillVisibility ───────────────────────────────────────

describe('computeSkillVisibility', () => {
  test('returns effectivelyHidden=false for no override and no disableModelInvocation', () => {
    const v = computeSkillVisibility('my-skill', false, {});
    expect(v.override).toBe(null);
    expect(v.disableModelInvocation).toBe(false);
    expect(v.effectivelyHidden).toBe(false);
  });

  test('returns effectivelyHidden=true for override=off', () => {
    const v = computeSkillVisibility('my-skill', false, { 'my-skill': 'off' });
    expect(v.override).toBe('off');
    expect(v.effectivelyHidden).toBe(true);
  });

  test('returns effectivelyHidden=true for disableModelInvocation=true', () => {
    const v = computeSkillVisibility('my-skill', true, {});
    expect(v.disableModelInvocation).toBe(true);
    expect(v.effectivelyHidden).toBe(true);
  });

  test('returns effectivelyHidden=false for override=name-only', () => {
    const v = computeSkillVisibility('my-skill', false, { 'my-skill': 'name-only' });
    expect(v.override).toBe('name-only');
    expect(v.effectivelyHidden).toBe(false);
  });

  test('does not apply override from different skill name', () => {
    const v = computeSkillVisibility('my-skill', false, { 'other-skill': 'off' });
    expect(v.override).toBe(null);
    expect(v.effectivelyHidden).toBe(false);
  });
});

// ── readCcDiagnostics ────────────────────────────────────────────

describe('readCcDiagnostics', () => {
  test('returns diagnostics with unset ENABLE_TOOL_SEARCH by default', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({}));
      const { diagnostics } = await readCcDiagnostics(undefined, {}, settingsPath);
      expect(diagnostics.enableToolSearch).toBe('unset');
      expect(diagnostics.toolSearchEffective).toBe(true);
      expect(diagnostics.runtimeSupportsToolSearch).toBe(true);
    });
  });

  test('reads skillOverrides from user settings', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({ skillOverrides: { 'my-skill': 'off', 'other': 'name-only' } }),
      );
      const { skillOverrides } = await readCcDiagnostics(undefined, {}, settingsPath);
      expect(skillOverrides['my-skill']).toBe('off');
      expect(skillOverrides['other']).toBe('name-only');
    });
  });

  test('applies local > project > user precedence for skillOverrides', async () => {
    await withTempDir(async (dir) => {
      const userSettingsPath = join(dir, 'user-settings.json');
      writeFileSync(
        userSettingsPath,
        JSON.stringify({ skillOverrides: { 'skill-a': 'off', 'skill-b': 'on' } }),
      );

      const projectDir = join(dir, 'myproject');
      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ skillOverrides: { 'skill-a': 'name-only' } }),  // overrides user
      );
      writeFileSync(
        join(projectDir, '.claude', 'settings.local.json'),
        JSON.stringify({ skillOverrides: { 'skill-b': 'off' } }),  // overrides project+user
      );

      const { skillOverrides } = await readCcDiagnostics(projectDir, {}, userSettingsPath);
      expect(skillOverrides['skill-a']).toBe('name-only');  // project wins over user
      expect(skillOverrides['skill-b']).toBe('off');         // local wins over user
    });
  });

  test('toolSearchEffective=false when ENABLE_TOOL_SEARCH=false in env', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({}));
      const { diagnostics } = await readCcDiagnostics(
        undefined,
        { ENABLE_TOOL_SEARCH: 'false' },
        settingsPath,
      );
      expect(diagnostics.toolSearchEffective).toBe(false);
    });
  });

  test('gracefully returns empty overrides when settings file is absent', async () => {
    await withTempDir(async (dir) => {
      const { skillOverrides, diagnostics } = await readCcDiagnostics(
        undefined,
        {},
        join(dir, 'nonexistent.json'),
      );
      expect(skillOverrides).toEqual({});
      expect(diagnostics.enableToolSearch).toBe('unset');
    });
  });
});

// ── previewSkillOverride ─────────────────────────────────────────

describe('previewSkillOverride', () => {
  test('returns updated skillOverrides in newContent without writing', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));

      const { oldContent, newContent } = previewSkillOverride(settingsPath, 'my-skill', 'off');

      expect(JSON.parse(oldContent)).not.toHaveProperty('skillOverrides');
      expect(JSON.parse(newContent).skillOverrides?.['my-skill']).toBe('off');
      // file is unchanged
      expect(readFileSync(settingsPath, 'utf8')).toBe(JSON.stringify({ theme: 'dark' }));
    });
  });

  test('preview for null removes the key', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ skillOverrides: { 'my-skill': 'off' } }));

      const { newContent } = previewSkillOverride(settingsPath, 'my-skill', null);
      const parsed = JSON.parse(newContent) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('skillOverrides');
    });
  });

  test('preserves unknown top-level keys', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', customFlag: true }));

      const { newContent } = previewSkillOverride(settingsPath, 'x', 'on');
      const parsed = JSON.parse(newContent) as Record<string, unknown>;
      expect(parsed.theme).toBe('dark');
      expect(parsed.customFlag).toBe(true);
    });
  });
});

// ── setSkillOverride ─────────────────────────────────────────────

describe('setSkillOverride', () => {
  test('creates settings file if absent and sets override', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(false);

      await setSkillOverride(settingsPath, 'new-skill', 'name-only');

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      expect((parsed.skillOverrides as Record<string, string>)['new-skill']).toBe('name-only');
    });
  });

  test('sets override in existing file preserving unknown keys', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ theme: 'light', customKey: 42 }));

      await setSkillOverride(settingsPath, 'skill-a', 'off');

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(parsed.theme).toBe('light');
      expect(parsed.customKey).toBe(42);
      expect((parsed.skillOverrides as Record<string, string>)['skill-a']).toBe('off');
    });
  });

  test('removes override when value=null', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ skillOverrides: { 'skill-a': 'off', 'skill-b': 'on' } }));

      await setSkillOverride(settingsPath, 'skill-a', null);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const overrides = parsed.skillOverrides as Record<string, string>;
      expect(overrides).not.toHaveProperty('skill-a');
      expect(overrides['skill-b']).toBe('on');
    });
  });

  test('removes skillOverrides key entirely when last entry is removed', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ skillOverrides: { 'only-skill': 'off' } }));

      await setSkillOverride(settingsPath, 'only-skill', null);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('skillOverrides');
    });
  });

  test('returns old and new content for diffing', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({}));

      const { oldContent, newContent } = await setSkillOverride(settingsPath, 'skill-x', 'user-invocable-only');
      expect(JSON.parse(oldContent)).not.toHaveProperty('skillOverrides');
      expect((JSON.parse(newContent) as { skillOverrides: Record<string, string> }).skillOverrides['skill-x'])
        .toBe('user-invocable-only');
    });
  });

  test('concurrent calls serialize correctly without data loss', async () => {
    await withTempDir(async (dir) => {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({}));

      // Fire 5 concurrent writes for different skill names
      await Promise.all([
        setSkillOverride(settingsPath, 'skill-1', 'off'),
        setSkillOverride(settingsPath, 'skill-2', 'name-only'),
        setSkillOverride(settingsPath, 'skill-3', 'on'),
        setSkillOverride(settingsPath, 'skill-4', 'user-invocable-only'),
        setSkillOverride(settingsPath, 'skill-5', 'off'),
      ]);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const overrides = parsed.skillOverrides as Record<string, string>;
      expect(overrides['skill-1']).toBe('off');
      expect(overrides['skill-2']).toBe('name-only');
      expect(overrides['skill-3']).toBe('on');
      expect(overrides['skill-4']).toBe('user-invocable-only');
      expect(overrides['skill-5']).toBe('off');
    });
  });
});
