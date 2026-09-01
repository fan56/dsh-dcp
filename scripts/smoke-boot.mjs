#!/usr/bin/env node
// Boot-smoke: mount the freshly packed dsh-dcp into a scratch dsh profile and
// boot it with the real dsh CLI.
//
// Unlike dsh-cron (which mounts through the bundle patch), this exercises the
// cordis.patch.yml mechanism — the same layer scripts/setup.mjs writes for
// users: the profile patch disables the default `compaction-basic` backend and
// inserts dsh-dcp by absolute path.
//
//   1. npm pack the repo → tarball
//   2. scratch $DSH_HOME/profiles/smoke: the dsh-base bundle plus the tarball
//      as a file: dependency, and a cordis.patch.yml carrying the
//      disable-compaction-basic + insert-dsh-dcp mount block
//   3. pnpm install in the profile
//   4. `dsh --profile smoke --dump-config` must compose dsh-dcp into the tree
//      (mount/patch-layer proof)
//   5. a real boot under a timeout must load the plugin tree without a loader
//      error (a healthy boot is silent and survives to the kill signal; a
//      broken plugin dies within ~1s with the loader error)
//
// The dsh CLI comes from $DSH_BIN if set (e.g. a scratch alpha closure:
// DSH_BIN=~/tmp/dsh-alpha-closure/node_modules/@deepseek-ai/dsh/lib/bin.js),
// otherwise `dsh` on PATH.
//
// Exit 0 = mounted and boots clean. Temp dir is kept and printed on failure,
// removed on success.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const ownName = pkg.name // @aiwayds/dsh-dcp
const entryId = 'dsh-dcp'

const work = mkdtempSync(path.join(tmpdir(), 'dsh-dcp-smoke-'))
const home = path.join(work, 'dsh-home')
const profile = path.join(home, 'profiles', 'smoke')
mkdirSync(profile, { recursive: true })

function fail(message, output = '') {
  console.error(`smoke-boot: FAIL — ${message}`)
  if (output) console.error(output.split('\n').slice(0, 30).join('\n'))
  console.error(`smoke-boot: scratch kept at ${work}`)
  process.exit(1)
}

const dshBin = process.env.DSH_BIN || 'dsh'
const dsh = (args, opts = {}) => spawnSync(dshBin, args, { cwd: profile, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, ...opts })

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' })
if (pack.status !== 0 || pack.error) fail('npm pack failed', `${pack.stdout}\n${pack.stderr}`)
const tarball = path.join(work, pack.stdout.trim().split('\n').at(-1) ?? '')

writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root — empty; the tree is composed from the bundle patches\n[]\n')
// The mount layer under test — isomorphic with scripts/setup.mjs's output:
// compaction-basic disabled, dsh-dcp inserted by absolute entry path.
writeFileSync(path.join(profile, 'cordis.patch.yml'), `# scratch smoke profile: dsh-dcp mounted the setup.mjs way
- id: compaction-basic
  disabled: true
- insert:
    - id: ${entryId}
      name: ${path.join(profile, 'node_modules', '@aiwayds', 'dsh-dcp', 'lib', 'index.js')}
      config:
        thresholdRatio: 0.7
        language: zh
`)
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-smoke',
  private: true,
  dependencies: {
    [ownName]: `file:${tarball}`,
  },
  dsh: {
    profile: {
      // dsh-base brings the standard tree (including compaction-basic) that
      // the patch layer then re-wires; dsh-dcp itself mounts via the patch.
      bundles: [
        '@deepseek-ai/dsh-base',
      ],
    },
  },
}, null, 2) + '\n')

const install = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8' })
if (install.status !== 0 || install.error) fail('pnpm install in the scratch profile failed', `${install.stdout}\n${install.stderr}`)

// Phase 1 — mount proof: the composed tree must carry the dsh-dcp entry, with
// compaction-basic disabled rather than removed-by-default.
const dump = dsh(['--profile', 'smoke', '--dump-config'])
if (dump.status !== 0 || dump.error) fail('dsh --dump-config failed on the scratch profile', `${dump.stdout}\n${dump.stderr}`)
if (!dump.stdout.includes(entryId)) {
  fail(`the composed profile tree does not contain the "${entryId}" entry — the patch mount is broken`, dump.stdout)
}

// Phase 2 — boot proof: the plugin tree must LOAD without a loader error.
const bootSeconds = 25
const boot = dsh(['--profile', 'smoke'], { timeout: bootSeconds * 1000, killSignal: 'SIGKILL' })
const output = `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`
const loaderErrors = [
  /plugin tree failed to load/,
  /failed to apply loader entry/,
  /cannot get property ".*" without inject/,
  /cannot get required service/,
  /Cannot find (package|module)/,
  /unknown key/,
]
const hit = loaderErrors.filter((re) => re.test(output))
if (hit.length > 0) {
  fail('the real host failed to load the plugin tree:', output.split('\n').filter((line) => hit.some((re) => re.test(line)) || /Error/.test(line)).slice(0, 15).join('\n'))
}
if (boot.signal !== 'SIGKILL' && boot.status !== 0) {
  fail(`dsh exited early with code ${boot.status} and no loader error — unexpected`, output)
}

console.log(`smoke-boot: PASS — ${ownName} mounted via cordis.patch.yml (compaction-basic disabled), composed into the scratch profile tree, and booted clean in real dsh (${boot.signal === 'SIGKILL' ? `survived ${bootSeconds}s boot window` : `exited ${boot.status}`})`)
rmSync(work, { recursive: true, force: true })
