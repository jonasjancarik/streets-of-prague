#!/usr/bin/env node
// Makes a git worktree of the game runnable on its own, so that a Claude Code session
// working in one doesn't reload every other session's game with each save
// (docs/handbook.md, "Scenes in a busy checkout"):
//
//   node scripts/worktree-setup.mjs            in the worktree (or: … <its folder>)
//   node scripts/worktree-setup.mjs --hook     the same for the SessionStart hook in
//                                              .claude/settings.json: what it did goes to
//                                              the session, and it leaves npm ci to it
//
// In the worktree it
// - links public/data to the main checkout's map data (a junction on Windows: no copy,
//   and removing the worktree removes only the link),
// - checks that the packages resolve: a worktree under the main checkout's
//   .claude/worktrees/ finds the main checkout's node_modules by Node's usual lookup up
//   the folders; elsewhere, or when package-lock.json differs from the main
//   checkout's, it runs npm ci,
// - gives the dev server a port of its own (5200–5289, free and not another worktree's),
//   kept in the worktree's .claude/launch.json, which vite.config.js, scripts/scene.mjs
//   and the desktop app's dev-server preview read,
// - turns the repository's symlinks (.claude/skills), which git checks out as small text
//   files where it can't make symlinks, into junctions git leaves alone.
// In any checkout, it makes sure git can create worktrees on Windows without Developer
// Mode: there `core.symlinks = true` makes every checkout of a new worktree fail with
// "unable to create symlink … Permission denied", so linked worktrees get false and the
// main checkout keeps true (an includeIf for its own .git folder).
// Running it again changes nothing that is already right.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { checkoutOf, launchConfig, MAIN_PORT } from './checkout.mjs';

const argv = process.argv.slice(2);
const HOOK = argv.includes('--hook');
// A hook is told the session's folder on stdin ({ "cwd": … }). (Read as a stream:
// readFileSync(0) fails on a pipe on Windows.)
async function hookFolder() {
  if (!HOOK || process.stdin.isTTY) return null;
  let data = '', input = null;
  process.stdin.setEncoding('utf8');
  await Promise.race([
    new Promise((ok) => {
      process.stdin.on('data', (c) => { data += c; try { input = JSON.parse(data); ok(); } catch {} }).on('end', ok).on('error', ok);
    }),
    new Promise((ok) => setTimeout(ok, 1000)),
  ]);
  process.stdin.destroy();
  return input?.cwd || null;
}
const target = argv.find((a) => !a.startsWith('--')) || await hookFolder() || process.cwd();
const WINDOWS = process.platform === 'win32';
// Dev server ports for worktrees: clear of the main checkout's 5191, the scene servers'
// 5199 and 5300–5699 (scripts/scene.mjs) and the handbook's example 5291.
const PORTS = { from: 5200, count: 90 };

const done = [], advice = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const slash = (p) => p.replaceAll('\\', '/');

// ---- The repository: worktrees without symlinks where there can be none -------------

// Whether this process may create a symlink (on Windows: Developer Mode or the
// privilege, which a usual account has neither of).
function canSymlink() {
  const at = join(tmpdir(), `sop-symlink-${process.pid}`);
  try { symlinkSync('nowhere', at, 'file'); unlinkSync(at); return true; } catch { return false; }
}

function symlinkConfig(co) {
  const shared = join(co.commonDir, 'config');
  const value = tryGit(co.main, 'config', '--file', shared, '--get', 'core.symlinks');
  if (value !== 'true' || canSymlink()) return;
  // The main checkout already has its symlinks and keeps them: git there goes on
  // treating them as symlinks. Only checkouts made from now on get text files.
  const own = join(co.commonDir, 'config.main-checkout');
  writeFileSync(own, [
    '# Written by scripts/worktree-setup.mjs. The main checkout keeps real symlinks',
    '# (.claude/skills); linked worktrees, where Windows without Developer Mode cannot make',
    '# them, check them out as text files (core.symlinks = false in config) and',
    '# scripts/worktree-setup.mjs turns those into junctions.',
    '[core]', '\tsymlinks = true', '',
  ].join('\n'));
  git(co.main, 'config', '--file', shared, `includeIf.gitdir/i:${slash(co.commonDir)}.path`, 'config.main-checkout');
  git(co.main, 'config', '--file', shared, 'core.symlinks', 'false');
  done.push('git config: new worktrees check out symlinks as text files (this account cannot create symlinks), the main checkout keeps its own');
}

// ---- The worktree --------------------------------------------------------------------

// A link to a folder: a junction on Windows (no privilege needed; absolute target).
function linkFolder(path, to) {
  if (WINDOWS) symlinkSync(resolve(to), path, 'junction');
  else symlinkSync(relative(dirname(path), to), path, 'dir');
}
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

// Tracked symlinks that came out as text files holding the link's target.
function fixLinks(co) {
  const links = tryGit(co.root, 'ls-files', '-s')?.split('\n').filter((l) => l.startsWith('120000 ')) ?? [];
  const fixed = [];
  for (const line of links) {
    const path = line.slice(line.indexOf('\t') + 1);
    const at = join(co.root, path);
    if (isLink(at) || !exists(at) || !lstatSync(at).isFile()) continue;
    const to = readFileSync(at, 'utf8');
    const dest = resolve(dirname(at), to);
    if (to !== tryGit(co.root, 'cat-file', 'blob', `:${path}`) || !existsSync(dest)) continue;
    unlinkSync(at);
    try {
      if (statSync(dest).isDirectory()) linkFolder(at, dest);
      else linkSync(dest, at); // a file: a hard link, which reads the same
    } catch (e) {
      writeFileSync(at, to);
      advice.push(`Could not link ${path} to ${to}: ${e.message}`);
      continue;
    }
    git(co.root, 'update-index', '--skip-worktree', '--', path);
    fixed.push(path);
  }
  if (fixed.length) done.push(`linked ${fixed.join(', ')} (git skips ${fixed.length > 1 ? 'them' : 'it'}: git update-index --no-skip-worktree to undo)`);
}

function mapData(co) {
  const own = join(co.root, 'public', 'data'), main = join(co.main, 'public', 'data');
  if (exists(own)) {
    if (isLink(own) && !existsSync(own)) advice.push(`public/data links to a folder that is gone; remove the link (rmdir on Windows) and run this again`);
    return;
  }
  if (!existsSync(main)) { advice.push(`The main checkout has no map data (${main}): build it there (docs/handbook.md, "Map data")`); return; }
  mkdirSync(dirname(own), { recursive: true });
  linkFolder(own, main);
  done.push(`linked public/data to the main checkout's map data`);
}

function packages(co) {
  const req = createRequire(join(co.root, 'package.json'));
  let found = null;
  try { found = req.resolve('vite/package.json'); } catch {}
  // (The packages each lock file installs: line endings differ between checkouts.)
  const lock = (root) => { try { return JSON.stringify(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages); } catch { return null; } };
  const ownModules = found && resolve(found).startsWith(resolve(co.root, 'node_modules'));
  const differs = lock(co.root) !== lock(co.main);
  if (found && (ownModules || !differs)) return;
  const why = !found ? 'the packages are not found from here' : 'package-lock.json differs from the main checkout\'s';
  if (HOOK) { advice.push(`Run npm ci in this worktree: ${why}`); return; }
  console.error(`npm ci (${why})…`);
  const r = spawnSync('npm ci --no-audit --no-fund', { cwd: co.root, stdio: ['ignore', 2, 2], shell: true });
  if (r.status === 0) done.push('installed the packages (npm ci)');
  else advice.push('npm ci failed; see above');
}

const free = (port) => new Promise((ok) => {
  const s = createServer();
  s.once('error', () => ok(false));
  s.listen(port, '0.0.0.0', () => s.close(() => ok(true)));
});

// The ports the other worktrees' launch.json files give.
function takenPorts(co) {
  const list = tryGit(co.main, 'worktree', 'list', '--porcelain') ?? '';
  const out = new Map();
  for (const m of list.matchAll(/^worktree (.+)$/gm)) {
    const root = resolve(m[1]);
    if (root === resolve(co.root) || root === resolve(co.main)) continue;
    const port = Number(launchConfig(root)?.port);
    if (port) out.set(port, basename(root));
  }
  return out;
}

async function devServerPort(co) {
  const file = join(co.root, '.claude', 'launch.json');
  let launch = { version: '0.0.1', configurations: [] };
  try { launch = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  launch.configurations ??= [];
  const taken = takenPorts(co);
  const had = Number(launch.configurations.find((c) => c.name === 'dev')?.port);
  let port = had && had !== MAIN_PORT && !taken.has(had) ? had : 0;
  if (!port) {
    let h = 0;
    for (const ch of basename(co.root)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    for (let i = 0; i < PORTS.count && !port; i++) {
      const p = PORTS.from + ((h + i) % PORTS.count);
      if (!taken.has(p) && await free(p)) port = p;
    }
    if (!port) { advice.push(`No free dev server port in ${PORTS.from}–${PORTS.from + PORTS.count - 1}`); return null; }
  }
  const dev = { name: 'dev', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '--', '--port', String(port), '--strictPort'], port };
  const before = JSON.stringify(launch);
  launch.configurations = [dev, ...launch.configurations.filter((c) => c.name !== 'dev')];
  if (JSON.stringify(launch) !== before) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(launch, null, 2)}\n`);
    done.push(`dev server port ${port} (.claude/launch.json)`);
  }
  return port;
}

// ---- Then ----------------------------------------------------------------------------

const co = checkoutOf(target);
if (!co) { if (!HOOK) console.error(`Not in a git checkout: ${target}`); process.exit(HOOK ? 0 : 1); }
try {
  symlinkConfig(co);
  fixLinks(co);
  let port = null;
  if (co.linked) {
    mapData(co);
    packages(co);
    port = await devServerPort(co);
  } else if (!HOOK) {
    console.error(`${co.root} is the main checkout; run this in a worktree (git worktree add .claude/worktrees/<name> …).`);
  }
  const lines = [];
  if (co.linked) {
    lines.push(`This session works in a git worktree, ${co.root}, of the main checkout ${co.main}.`);
    // (A worktree of a commit before this setup has a vite.config.js and scene.mjs that
    // don't know the port: it goes on their command lines.)
    let knows = false;
    try { knows = readFileSync(join(co.root, 'vite.config.js'), 'utf8').includes('checkout.mjs'); } catch {}
    if (port) {
      lines.push(knows
        ? `Its own dev server: npm run dev (http://localhost:${port}/, not ${MAIN_PORT}, which is the main checkout's); scripts/scene.mjs uses it unless given --url.`
        : `Its own dev server: npm run dev -- --port ${port} --strictPort (http://localhost:${port}/, not ${MAIN_PORT}, which is the main checkout's), and scripts/scene.mjs needs --url http://localhost:${port}/ (this commit's vite.config.js and scene.mjs predate scripts/worktree-setup.mjs).`);
      lines.push('Saves here reload only games from this dev server.');
    }
  }
  if (done.length) lines.push(`worktree-setup: ${done.join('; ')}.`);
  for (const a of advice) lines.push(`worktree-setup: ${a}`);
  // The hook's output goes to the session as context: only about a worktree, or a fix.
  if (lines.length && (co.linked || done.length || advice.length)) console.log(lines.join('\n'));
} catch (e) {
  console.log(`worktree-setup failed: ${e.message}`);
  process.exit(HOOK ? 0 : 1);
}
