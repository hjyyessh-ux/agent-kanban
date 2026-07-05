import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface FrontmatterWriteResult {
  filePath: string;
  oldContent: string;
  newContent: string;
  changed: boolean;
}

/**
 * Pure transform: add/update/remove `disable-model-invocation` in SKILL.md content.
 * All other frontmatter keys and the body are preserved verbatim.
 */
export function applyDisableModelInvocation(content: string, value: boolean): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);

  if (!fmMatch) {
    // No frontmatter — synthesize one if enabling, otherwise no-op
    if (value) {
      return `---\ndisable-model-invocation: true\n---\n${content}`;
    }
    return content;
  }

  const [, openFence, fmBody, closeFence, rest] = fmMatch;
  const lines = fmBody.split(/\r?\n/);
  const existingIdx = lines.findIndex((l) => /^disable-model-invocation\s*:/.test(l));

  let newLines: string[];
  if (value) {
    if (existingIdx >= 0) {
      newLines = [...lines];
      newLines[existingIdx] = 'disable-model-invocation: true';
    } else {
      newLines = [...lines, 'disable-model-invocation: true'];
    }
  } else {
    if (existingIdx < 0) return content; // already absent — no-op
    newLines = lines.filter((_, i) => i !== existingIdx);
  }

  return `${openFence}${newLines.join('\n')}${closeFence}${rest}`;
}

/**
 * Read SKILL.md, apply disable-model-invocation change, atomically rewrite.
 * Returns old/new content for diffing; changed=false if no write occurred.
 */
export function setDisableModelInvocation(
  filePath: string,
  value: boolean,
): FrontmatterWriteResult {
  if (!existsSync(filePath)) throw new Error(`SKILL.md not found: ${filePath}`);

  const oldContent = readFileSync(filePath, 'utf8');
  const newContent = applyDisableModelInvocation(oldContent, value);

  if (newContent === oldContent) {
    return { filePath, oldContent, newContent, changed: false };
  }

  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, newContent, 'utf8');
  renameSync(tmpPath, filePath);

  return { filePath, oldContent, newContent, changed: true };
}
