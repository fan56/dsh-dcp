/**
 * Closure linker: point every `node_modules/@deepseek-ai/*` entry at one dsh
 * closure (the installed dsh CLI's own `node_modules/@deepseek-ai` tree).
 *
 * Why this exists: dsh-dcp is a plugin that runs *inside* the installed dsh
 * CLI, and its source imports the `@deepseek-ai/*` host packages (cordis,
 * dsh-compaction-basic, dsh-llm, …). This repo is lib-as-source — there is no
 * `src/` and no build step — so typecheck (`pnpm check`, tsc checkJs) and the
 * node:test suite must resolve those imports against exactly ONE copy of the
 * host graph: the closure the real runtime uses. Linking also guarantees a
 * single `@deepseek-ai/cordis` instance, which the `declare module`
 * augmentations (e.g. `ctx.commands`) require.
 *
 * NOTE on the guard below: unlike a TS repo this repo has no `src/` directory
 * — `lib/` IS the source — so the "am I inside the repo?" check looks for
 * `lib/` (plus `.git/`, which a published tarball never carries). The script
 * is never wired as a lifecycle hook (no postinstall); it is run explicitly
 * (CI step, `pnpm link:closure`), and the guard only protects stray manual
 * runs from outside the repo.
 *
 * Resolution order for the closure:
 *   0) `$DSH_CLOSURE_DIR` — explicit override, e.g. a scratch closure from
 *      `npm i --prefix ~/tmp/dsh-alpha-closure @deepseek-ai/dsh@alpha`:
 *      DSH_CLOSURE_DIR=~/tmp/dsh-alpha-closure/node_modules/@deepseek-ai node scripts/link-dsh-closure.mjs
 *   1) the `dsh` bin on PATH → its package's node_modules/@deepseek-ai
 *   2) `npm root -g` nested closure, then npm's flat global @deepseek-ai scope
 *
 * It is a no-op (exit 0) when no dsh closure is found.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// Guard: dev convenience for THIS repo only. lib/ is this repo's source (there
// is no src/), and .git/ only exists in a working clone — never in a packed
// tarball — so both together prove "inside the repo, not a consumer install".
if (!existsSync(join(repoRoot, 'lib')) || !existsSync(join(repoRoot, '.git'))) {
  process.exit(0)
}
const scopeDir = join(repoRoot, 'node_modules', '@deepseek-ai')

/** The dsh closure: a node_modules dir whose @deepseek-ai scope is complete. */
function findDshClosure() {
  // 0) Explicit override for dev/typecheck against an unreleased dsh line.
  const override = process.env.DSH_CLOSURE_DIR
  if (override !== undefined && override !== '') {
    const dir = realpathSync(override)
    if (existsSync(join(dir, 'cordis'))) return dir
    console.warn(`[link-dsh-closure] DSH_CLOSURE_DIR=${override} lacks @deepseek-ai/cordis — ignoring override`)
  }
  // 1) Follow the `dsh` bin — the most faithful pointer to the installed CLI
  //    (`/opt/homebrew/bin/dsh` → …/lib/bin.js → pkg dir → its node_modules).
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') {
      const real = realpathSync(bin)
      const closure = join(dirname(dirname(real)), 'node_modules', '@deepseek-ai')
      if (existsSync(join(closure, 'cordis'))) return closure
    }
  } catch { /* dsh not on PATH */ }
  // 2) Fall back to the global node_modules root — the dsh package's own
  //    nested closure (what current npm produces for a global install).
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const nested = join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
    if (existsSync(join(nested, 'cordis'))) return nested
    // 3) Last resort: npm's flat global layout, where dsh's @deepseek-ai/*
    //    deps are hoisted straight into <npm root -g>/@deepseek-ai next to
    //    the dsh package itself.
    const flat = join(root, '@deepseek-ai')
    if (existsSync(join(flat, 'cordis'))) return flat
  } catch { /* npm unavailable */ }
  return undefined
}

const closure = findDshClosure()
if (closure === undefined) {
  console.warn('[link-dsh-closure] no dsh closure found — skipping @deepseek-ai links (dev without dsh)')
  process.exit(0)
}

mkdirSync(scopeDir, { recursive: true })
let linked = 0
for (const name of readdirSync(closure)) {
  const target = join(scopeDir, name)
  const source = join(closure, name)
  try {
    // Replace any existing entry (stale symlink, or a local .pnpm copy a
    // previous install created) with the closure link.
    rmSync(target, { recursive: true, force: true })
    symlinkSync(source, target, 'junction')
    linked++
  } catch (error) {
    console.warn(`[link-dsh-closure] failed to link ${name}: ${(error instanceof Error ? error.message : String(error))}`)
  }
}
console.log(`[link-dsh-closure] linked ${linked} @deepseek-ai/* packages from ${closure}`)
