import { describe, expect, test } from 'bun:test';
import type { RuntimeCatalogEntry } from '../../../../src/core/runtime-config';
import {
  buildWikiModelGroups,
  findWikiModelSelection,
  wikiModelSelectionKey,
} from './wiki-model-options';

describe('wiki model options', () => {
  test('includes every Codex and Claude catalog model and excludes unsupported runtimes', () => {
    const runtimes: RuntimeCatalogEntry[] = [
      {
        runtime: 'opencode',
        label: 'Opencode',
        selection: 'preset',
        models: [{ id: 'provider/model', label: 'Provider Model' }],
      },
      {
        runtime: 'claude',
        label: 'Claude',
        selection: 'model',
        models: [
          { id: 'claude-opus-5', label: 'Opus 5', tier: 'opus' },
          { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'haiku' },
        ],
      },
      {
        runtime: 'codex',
        label: 'Codex',
        selection: 'model',
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', tier: 'frontier' },
          { id: 'o3', label: 'o3', tier: 'general' },
        ],
      },
    ];

    const groups = buildWikiModelGroups(runtimes);

    expect(groups.map((group) => group.route)).toEqual(['codex', 'claude']);
    expect(groups.flatMap((group) => group.models.map((model) => model.id))).toEqual([
      'gpt-5.6-sol',
      'o3',
      'claude-opus-5',
      'claude-haiku-4-5',
    ]);
    expect(findWikiModelSelection(groups, 'codex', 'o3')).toBe(wikiModelSelectionKey('codex', 'o3'));
    expect(findWikiModelSelection(groups, 'claude', 'o3')).toBeNull();
  });
});
