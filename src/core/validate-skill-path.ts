import { realpathSync, existsSync } from 'node:fs';

/**
 * Returns true iff `filePath` resolves (following all symlinks) to a path that
 * is strictly inside one of `enabledRootDirs`. Blocks:
 *   - `..` traversal
 *   - symlink escape to directories outside the configured roots
 *   - paths that do not exist on disk
 *
 * Used to guard all SKILL.md reads and (future) writes so the server cannot be
 * tricked into serving arbitrary files from the user's filesystem.
 */
export function validateSkillPath(filePath: string, enabledRootDirs: string[]): boolean {
  if (!existsSync(filePath)) return false;

  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return false;
  }

  for (const rootDir of enabledRootDirs) {
    if (!existsSync(rootDir)) continue;
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(rootDir);
    } catch {
      continue;
    }
    // Ensure the root ends without a trailing slash, then append one for the
    // prefix check so that `/foo/bar` doesn't accidentally match `/foo/barz`.
    const prefix = resolvedRoot.endsWith('/') ? resolvedRoot : resolvedRoot + '/';
    if (resolved.startsWith(prefix) || resolved === resolvedRoot) {
      return true;
    }
  }

  return false;
}
