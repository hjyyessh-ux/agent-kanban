import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SkillStore } from '../core/skill-store';
import { withTempDir } from './setup';

describe('SkillStore legacy inventory compatibility', () => {
  test('loads the existing multi-runtime skill inventory without omission', async () => {
    await withTempDir(async (dir) => {
      const skills = [
        {
          id: 'claude-skill', runtime: 'claude', kind: 'claude_skill',
          skillName: 'claude-skill', displayName: '/claude-skill', description: 'Claude skill',
          source: 'claude-user', directory: '/tmp/claude-skill', scope: 'user',
        },
        {
          id: 'skills:codex-skill', runtime: 'codex', kind: 'codex_skill',
          skillName: 'codex-skill', displayName: '$codex-skill', description: 'Codex skill',
          source: 'codex-user', directory: '/tmp/codex-skill', scope: 'user',
        },
        {
          id: 'open-skill', runtime: 'opencode', kind: 'opencode_skill',
          skillName: 'open-skill', displayName: '/open-skill', description: 'Opencode skill',
          source: 'opencode-user', directory: '/tmp/open-skill', scope: 'user',
        },
      ];
      await Bun.write(join(dir, 'skills.json'), JSON.stringify({
        version: 1,
        skills,
        lastSyncedAt: '2026-01-01T00:00:00.000Z',
      }));

      const loaded = await new SkillStore(dir).getSkills();
      expect(loaded).toHaveLength(3);
      expect(loaded.map((skill) => skill.runtime)).toEqual(['claude', 'codex', 'opencode']);
      expect(loaded.map((skill) => skill.id)).toEqual(skills.map((skill) => skill.id));
    });
  });
});
