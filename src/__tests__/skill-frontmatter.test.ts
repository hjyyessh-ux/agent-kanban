import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { applyDisableModelInvocation, setDisableModelInvocation } from '../core/skill-frontmatter';
import { withTempDir } from './setup';

// ── applyDisableModelInvocation (pure) ──────────────────────────

describe('applyDisableModelInvocation', () => {
  const SKILL_MD = `---
name: my-skill
description: Does something useful.
---

# My Skill

Body content preserved.
`;

  test('adds disable-model-invocation when value=true and key absent', () => {
    const result = applyDisableModelInvocation(SKILL_MD, true);
    expect(result).toContain('disable-model-invocation: true');
    // body preserved
    expect(result).toContain('Body content preserved.');
    // other keys preserved
    expect(result).toContain('name: my-skill');
    expect(result).toContain('description: Does something useful.');
  });

  test('preserves body verbatim when adding key', () => {
    const body = '\n# My Skill\n\nBody content preserved.\n';
    const result = applyDisableModelInvocation(SKILL_MD, true);
    expect(result).toContain(body);
  });

  test('no-op when value=false and key absent', () => {
    const result = applyDisableModelInvocation(SKILL_MD, false);
    expect(result).toBe(SKILL_MD);
  });

  test('removes key when value=false and key is present', () => {
    const withKey = `---
name: my-skill
disable-model-invocation: true
---

Body.
`;
    const result = applyDisableModelInvocation(withKey, false);
    expect(result).not.toContain('disable-model-invocation');
    expect(result).toContain('name: my-skill');
    expect(result).toContain('Body.');
  });

  test('updates existing key from false to true', () => {
    const withFalse = `---
name: my-skill
disable-model-invocation: false
---

Body.
`;
    const result = applyDisableModelInvocation(withFalse, true);
    expect(result).toContain('disable-model-invocation: true');
    expect(result).not.toContain('disable-model-invocation: false');
  });

  test('preserves other frontmatter keys when removing', () => {
    const withKey = `---
name: my-skill
description: A description.
disable-model-invocation: true
allowed-tools:
  - Bash
---

Body.
`;
    const result = applyDisableModelInvocation(withKey, false);
    expect(result).toContain('name: my-skill');
    expect(result).toContain('description: A description.');
    expect(result).toContain('allowed-tools:');
    expect(result).not.toContain('disable-model-invocation');
  });

  test('synthesizes frontmatter when file has none and value=true', () => {
    const noFm = '# Bare Skill\n\nNo frontmatter here.\n';
    const result = applyDisableModelInvocation(noFm, true);
    expect(result).toContain('---\ndisable-model-invocation: true\n---');
    expect(result).toContain('# Bare Skill');
  });

  test('no-op for bare file with value=false', () => {
    const noFm = '# Bare Skill\n';
    expect(applyDisableModelInvocation(noFm, false)).toBe(noFm);
  });
});

// ── setDisableModelInvocation (I/O) ─────────────────────────────

describe('setDisableModelInvocation', () => {
  const FIXTURE = `---
name: io-skill
description: IO test skill.
---

IO body preserved here.
`;

  test('writes new file content and returns changed=true', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'SKILL.md');
      writeFileSync(filePath, FIXTURE);

      const result = setDisableModelInvocation(filePath, true);

      expect(result.changed).toBe(true);
      expect(result.oldContent).toBe(FIXTURE);
      expect(result.newContent).toContain('disable-model-invocation: true');

      const onDisk = readFileSync(filePath, 'utf8');
      expect(onDisk).toBe(result.newContent);
    });
  });

  test('returns changed=false when no change needed', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'SKILL.md');
      writeFileSync(filePath, FIXTURE);

      const result = setDisableModelInvocation(filePath, false);

      expect(result.changed).toBe(false);
      expect(result.newContent).toBe(FIXTURE);
      // file on disk is unchanged
      expect(readFileSync(filePath, 'utf8')).toBe(FIXTURE);
    });
  });

  test('body is preserved after write', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'SKILL.md');
      writeFileSync(filePath, FIXTURE);

      setDisableModelInvocation(filePath, true);

      const onDisk = readFileSync(filePath, 'utf8');
      expect(onDisk).toContain('IO body preserved here.');
      expect(onDisk).toContain('name: io-skill');
      expect(onDisk).toContain('description: IO test skill.');
    });
  });

  test('throws when file does not exist', () => {
    expect(() =>
      setDisableModelInvocation('/nonexistent/path/SKILL.md', true),
    ).toThrow('not found');
  });

  test('roundtrip: add then remove leaves file identical', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'SKILL.md');
      writeFileSync(filePath, FIXTURE);

      setDisableModelInvocation(filePath, true);
      setDisableModelInvocation(filePath, false);

      const onDisk = readFileSync(filePath, 'utf8');
      expect(onDisk).toBe(FIXTURE);
    });
  });
});
