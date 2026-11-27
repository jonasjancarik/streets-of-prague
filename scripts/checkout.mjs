// Which checkout a folder belongs to: the main one or a linked git worktree (for one
// Claude Code session each, under .claude/worktrees/), where the main checkout is, and
// the port this checkout's dev server listens on. Used by vite.config.js,
// scripts/scene.mjs and scripts/worktree-setup.mjs (docs/handbook.md, "Scenes in a
// busy checkout"). Reads git's files directly rather than running git, for vite.config.js.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// The main checkout's dev server port.
export const MAIN_PORT = 5191;

// { root, linked, main, gitDir, commonDir } for the checkout holding `dir`, or null
// outside one. In a linked worktree `.git` is a file naming the worktree's own git
// folder (.git/worktrees/<name> in the main checkout), whose `commondir` leads back.
export function checkoutOf(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const dotGit = join(at, '.git');
    let stat = null;
    try { stat = statSync(dotGit); } catch {}
    if (stat?.isDirectory()) return { root: at, linked: false, main: at, gitDir: dotGit, commonDir: dotGit };
    if (stat?.isFile()) {
      const named = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (!named) return null;
      const gitDir = isAbsolute(named) ? named : resolve(at, named);
      let commonDir = gitDir;
      try { commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()); } catch {}
      return { root: at, linked: commonDir !== gitDir, main: dirname(commonDir), gitDir, commonDir };
    }
    if (dirname(at) === at) return null;
  }
}

// The "dev" configuration of a checkout's .claude/launch.json (the desktop app's dev
// servers; not in git), or null.
export function launchConfig(root) {
  const file = join(root, '.claude', 'launch.json');
  if (!existsSync(file)) return null;
  try {
    const launch = JSON.parse(readFileSync(file, 'utf8'));
    return launch.configurations?.find((c) => c.name === 'dev') ?? null;
  } catch { return null; }
}

// The port of this checkout's dev server: $PORT, else in a worktree the port its
// .claude/launch.json gives (scripts/worktree-setup.mjs writes it), else 5191. Null for
// a worktree not set up yet: the desktop app copies the main checkout's launch.json
// into a new worktree, and its 5191 is the main checkout's server, not this one's.
export function devPort(checkout) {
  if (process.env.PORT) return Number(process.env.PORT);
  if (!checkout?.linked) return MAIN_PORT;
  const port = Number(launchConfig(checkout.root)?.port);
  return port && port !== MAIN_PORT ? port : null;
}
