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
//   4. Phase A: setup.mjs mounts the profile patch (marker block), the
//      composed tree carries dsh-dcp with compaction-basic disabled, then
//      `setup.mjs --remove` strips it and the recomposed tree is back to
//      stock (this is what breaks a profile when the package is removed
//      without the reverse step)
//   5. Phase B: a hand-written mount pointing into the installed tarball —
//      the true user shape — composes, and a real boot under a timeout must
//      load the plugin tree without a loader error (a healthy boot is silent
//      and survives to the kill signal; a broken plugin dies within ~1s with
//      the loader error)
//
// The dsh CLI comes from $DSH_BIN if set (e.g. a scratch alpha closure:
// DSH_BIN=~/tmp/dsh-alpha-closure/node_modules/@deepseek-ai/dsh/lib/bin.js),
// otherwise `dsh` on PATH.
//
// Exit 0 = mounted and boots clean. Temp dir is kept and printed on failure,
// removed on success.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const ownName = pkg.name // @aiwayds/dsh-dcp
const entryId = 'dsh-dcp'

let observerDir = null

const work = mkdtempSync(path.join(tmpdir(), 'dsh-dcp-smoke-'))
const home = path.join(work, 'dsh-home')
const profile = path.join(home, 'profiles', 'smoke')
mkdirSync(profile, { recursive: true })

function fail(message, output = '') {
  console.error(`smoke-boot: FAIL — ${message}`)
  if (output) console.error(output.split('\n').slice(0, 30).join('\n'))
  console.error(`smoke-boot: scratch kept at ${work}`)
  if (observerDir) console.error(`smoke-boot: observer kept at ${observerDir}`)
  process.exit(1)
}

const dshBin = process.env.DSH_BIN || 'dsh'
const dsh = (args, opts = {}) => spawnSync(dshBin, args, { cwd: profile, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, ...opts })

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' })
if (pack.status !== 0 || pack.error) fail('npm pack failed', `${pack.stdout}\n${pack.stderr}`)
const tarball = path.join(work, pack.stdout.trim().split('\n').at(-1) ?? '')

writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root — empty; the tree is composed from the bundle patches\n[]\n')
// The patch file starts EMPTY: Phase A below drives the full setup.mjs
// mount → remove lifecycle against it, then Phase B hand-writes the mount
// (isomorphic with setup.mjs's output) for the real-boot proof.
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

// Phase A — the setup.mjs lifecycle: mount → compose → remove → stock tree.
// This is the exact pair of commands a standalone user runs (`npx dsh-dcp-setup`
// and its `--remove`), against the profile patch file they target.
const patchFile = path.join(profile, 'cordis.patch.yml')
const setup = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'setup.mjs'), patchFile], { encoding: 'utf8' })
if (setup.status !== 0 || setup.error) fail('setup.mjs mount failed', `${setup.stdout}\n${setup.stderr}`)
const dumpMounted = dsh(['--profile', 'smoke', '--dump-config'])
if (dumpMounted.status !== 0 || dumpMounted.error) fail('dsh --dump-config failed on the setup-mounted profile', `${dumpMounted.stdout}\n${dumpMounted.stderr}`)
if (!dumpMounted.stdout.includes(entryId) || !/compaction-basic\n(  name: .*\n)?  disabled: true/.test(dumpMounted.stdout)) {
  fail('the setup-mounted tree does not carry dsh-dcp with compaction-basic disabled', dumpMounted.stdout)
}
const remove = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'setup.mjs'), '--remove', patchFile], { encoding: 'utf8' })
if (remove.status !== 0 || remove.error) fail('setup.mjs --remove failed', `${remove.stdout}\n${remove.stderr}`)
const dumpAfter = dsh(['--profile', 'smoke', '--dump-config'])
if (dumpAfter.status !== 0 || dumpAfter.error) fail('dsh --dump-config failed after removal', `${dumpAfter.stdout}\n${dumpAfter.stderr}`)
if (dumpAfter.stdout.includes(entryId)) {
  fail(`the composed tree still contains the "${entryId}" entry after removal`, dumpAfter.stdout)
}
if (/compaction-basic\n(  name: .*\n)?  disabled: true/.test(dumpAfter.stdout)) {
  fail('compaction-basic is still disabled after removal — the stock backend did not come back', dumpAfter.stdout)
}
if (!dumpAfter.stdout.includes('compaction-basic')) {
  fail('compaction-basic vanished from the composed tree after removal', dumpAfter.stdout)
}
console.log('smoke-boot: setup.mjs mount → remove lifecycle restored the stock tree')

// A clean boot is NOT proof of activation: cordis leaves a plugin silently
// PENDING when an inject service is missing (fiber state 0, error=null, no
// /dcp command, no log line). Mount a read-only observer through the same patch
// layer and enumerate the live fibers and commands service from inside the
// host, then assert hard evidence of activation after the boot. The observer
// source is written to a scratch dir at runtime — never shipped in lib/.
const OBSERVER_SOURCE = `// Read-only activation observer mounted by scripts/smoke-boot.mjs.
// Never modifies services or the plugin tree. Cordis state enum (4.1.0):
// 0 PENDING, 1 LOADING, 2 ACTIVE, 3 FAILED, 4 DISPOSED, 5 UNLOADING.
import { writeFileSync } from 'node:fs'

const P = 'DCP_SMOKE_OBS'
const FILE = process.env.DCP_SMOKE_OBS_FILE
const log = (...p) => process.stderr.write('[' + P + '] ' + p.join(' ') + '\\n')
const SAMPLES = [0, 2000, 6000, 8000]
const VALID = new Set([0, 1, 2, 3, 4, 5])

function row(f) {
  return {
    uid: f.uid == null ? null : f.uid,
    name: f.runtime && f.runtime.name != null ? f.runtime.name : null,
    cb: f.runtime && f.runtime.callback && f.runtime.callback.name ? f.runtime.callback.name : null,
    state: f.state,
    inject: f.inject ? Object.keys(f.inject) : [],
    error: f._error ? String(f._error.message || f._error).slice(0, 300) : null,
  }
}

function isDcp(r) {
  return r.cb === 'DcpEngine' || r.name === 'DcpEngine'
}

export default function apply(ctx, config = {}) {
  function take() {
    const s = {
      ok: false, at: Date.now(), error: null, enumError: null,
      commandError: null, fiberCount: 0, dcp: [], dcpCommands: [],
      hasDcp: false, commandCount: 0,
    }
    try {
      const root = ctx.root
      if (!root || !root.registry || typeof root.registry.values !== 'function') {
        throw new Error('ctx.root.registry.values() unavailable')
      }
      const rows = []
      for (const runtime of root.registry.values()) {
        if (!runtime || !runtime.fibers) continue
        for (const fiber of runtime.fibers) rows.push(row(fiber))
      }
      s.fiberCount = rows.length
      s.dcp = rows.filter(isDcp)
      for (const d of s.dcp) {
        if (!VALID.has(d.state)) s.enumError = 'DcpEngine state ' + d.state + ' outside 0..5'
      }
      try {
        const commands = root.reflect.get('commands', true)
        if (!commands || typeof commands.list !== 'function') {
          throw new Error('commands service or commands.list unavailable')
        }
        const names = (commands.list(undefined) || []).map((d) => d && d.name)
        s.commandCount = names.length
        s.dcpCommands = names.filter((n) => n === 'dcp')
        s.hasDcp = names.includes('dcp')
      } catch (e) {
        s.commandError = String(e && e.message ? e.message : e)
      }
      s.ok = true
    } catch (e) {
      s.error = 'scan threw: ' + String(e && e.message ? e.message : e)
    }
    return s
  }

  function write(samples, done) {
    if (!FILE) { log('NO_OBS_FILE'); return }
    try {
      writeFileSync(FILE, JSON.stringify({ samples, done }))
    } catch (e) {
      log('WRITE_ERROR ' + String(e && e.message ? e.message : e))
    }
  }

  const samples = []
  SAMPLES.forEach((delay, i) => {
    setTimeout(() => {
      const s = take()
      samples.push(s)
      log('sample ' + i + ' @' + delay + 'ms fiberCount=' + s.fiberCount +
        ' dcp=' + JSON.stringify(s.dcp) +
        ' dcpCommands=' + JSON.stringify(s.dcpCommands) +
        ' hasDcp=' + s.hasDcp +
        ' ok=' + s.ok + ' error=' + s.error + ' enumError=' + s.enumError +
        ' commandError=' + s.commandError)
      write(samples, i === SAMPLES.length - 1)
    }, delay)
  })
}
`

function observerTail(bootOutput) {
  const lines = (bootOutput || '').split('\n')
  const obs = lines.filter((line) => line.includes('[DCP_SMOKE_OBS]'))
  return `[DCP_SMOKE_OBS] lines:\n${obs.join('\n')}\n--- boot log tail ---\n${lines.slice(-20).join('\n')}`
}

function readObservation(file, bootOutput) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    fail('observation mechanism failed — observer wrote no result file: ' + String(e), observerTail(bootOutput))
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail('observation mechanism failed — observer result is not JSON: ' + String(e), raw.slice(0, 500))
  }
  if (!data || !Array.isArray(data.samples) || data.samples.length === 0) {
    fail('observation mechanism failed — observer produced no samples', JSON.stringify(data).slice(0, 500))
  }
  if (data.done !== true) {
    fail('observation mechanism failed — observer did not finish all samples before the boot ended', observerTail(bootOutput))
  }
  return data
}

// Independent signal from the host itself: for optional entries that stayed
// PENDING/FAILED, dsh writes to stderr a block shaped like:
//   dsh: warning: N entries did not activate
//   <entry-id> (<entry-name>): pending (waiting for services: ...)
// The dsh-dcp entry (entryId) must never appear in that list. Scan the boot log
// (not the observer file) so this is a genuinely independent signal.
function didNotActivateHits(bootOutput) {
  const header = /^dsh: warning: \d+ entr(?:y|ies) did not activate/
  // Diagnostic lines are `<id> (<name>): ...`. Match the id exactly so the
  // observer plugin `dcp-smoke-observer` is never mistaken for `dsh-dcp`.
  const diagnostic = /^(\S+) \(/
  const hits = []
  let inBlock = false
  for (const line of (bootOutput || '').split('\n')) {
    if (header.test(line)) { inBlock = true; continue }
    if (!inBlock) continue
    if (!line.trim() || /^dsh: /.test(line)) { inBlock = false; continue }
    const m = diagnostic.exec(line)
    if (m && m[1] === entryId) hits.push(line.trim())
  }
  return hits
}

function assertActivation(data, bootOutput) {
  const samples = data.samples
  const last = samples.at(-1)
  if (!samples.some((s) => s.ok === true && s.error == null)) {
    fail('observation mechanism failed (cannot prove activation) — no usable sample', observerTail(bootOutput))
  }
  for (const s of samples) {
    if (s.enumError) {
      fail('observation mechanism failed (cannot prove activation) — ' + s.enumError, observerTail(bootOutput))
    }
  }
  if (last.ok !== true || last.error || last.commandError) {
    fail('observation mechanism failed (cannot prove activation) — final sample unusable: ' + JSON.stringify(last), observerTail(bootOutput))
  }
  if (!Array.isArray(last.dcp) || last.dcp.length === 0) {
    fail('observation mechanism failed (cannot prove activation) — DcpEngine fiber not found in registry', observerTail(bootOutput))
  }
  const offenders = []
  for (const r of last.dcp) {
    // Canary: `error` is read from the TS-private `_error` in the observer. If
    // upstream renames that private field, every read becomes null and the
    // `error===null` check below turns vacuously true. A FAILED fiber (3) is
    // guaranteed by cordis to carry an error; seeing 3 with error=null means
    // the observation mechanism itself drifted, not a real dsh-dcp state.
    if (r.state === 3 && r.error === null) {
      fail('observation mechanism failed (error field unreadable) — DcpEngine fiber reports state=3 (FAILED) with error=null; the _error field may have been renamed upstream: uid=' + JSON.stringify(r.uid) + ' name=' + JSON.stringify(r.name) + ' inject=' + JSON.stringify(r.inject), observerTail(bootOutput))
    }
    const where = `uid=${JSON.stringify(r.uid)} name=${JSON.stringify(r.name)} state=${r.state} inject=${JSON.stringify(r.inject)}`
    if (r.state !== 2) offenders.push(`DcpEngine fiber ${where} (expected state=2/ACTIVE)`)
    if (r.error !== null) offenders.push(`DcpEngine fiber ${where} error=${r.error}`)
  }
  if (last.hasDcp !== true) offenders.push(`no /dcp command registered (commandCount=${last.commandCount}, dcpCommands=${JSON.stringify(last.dcpCommands)})`)
  const inactive = didNotActivateHits(bootOutput)
  if (inactive.length > 0) offenders.push(`host "did not activate" warning lists dsh-dcp: ${inactive.join(' | ')}`)
  if (offenders.length > 0) {
    fail('dsh-dcp did not activate: ' + offenders.join('; ') + ' | final sample: ' + JSON.stringify(last), observerTail(bootOutput))
  }
  console.log(`smoke-boot: activation OK — all ${last.dcp.length} DcpEngine fiber(s) state=2 (ACTIVE), error=null, /dcp command registered (commandCount=${last.commandCount}); ${samples.length} samples`)
}

// Phase B — mount proof: the composed tree must carry the dsh-dcp entry, with
// compaction-basic disabled rather than removed-by-default. The hand-written
// mount points INTO the installed tarball (the true user shape), so the boot
// below exercises the packed artifact.
// The observer lives in its own scratch dir (outside the pack/install tree)
// so its path never leaks into the mount assertions above.
observerDir = mkdtempSync(path.join(tmpdir(), 'dcp-smoke-observer-'))
writeFileSync(path.join(observerDir, 'package.json'), JSON.stringify({
  name: 'dcp-smoke-observer', version: '1.0.0', private: true, type: 'module', main: 'index.js',
}, null, 2) + '\n')
writeFileSync(path.join(observerDir, 'index.js'), OBSERVER_SOURCE)
const obsFile = path.join(work, 'activation-observation.json')

writeFileSync(path.join(profile, 'cordis.patch.yml'), `# scratch smoke profile: dsh-dcp mounted the setup.mjs way
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- insert:
    - id: ${entryId}
      name: ${path.join(profile, 'node_modules', '@aiwayds', 'dsh-dcp', 'lib', 'index.js')}
      config:
        thresholdRatio: 0.7
        language: zh
    - id: dcp-smoke-observer
      name: ${path.join(observerDir, 'index.js')}
`)
const dump = dsh(['--profile', 'smoke', '--dump-config'])
if (dump.status !== 0 || dump.error) fail('dsh --dump-config failed on the scratch profile', `${dump.stdout}\n${dump.stderr}`)
if (!dump.stdout.includes(entryId)) {
  fail(`the composed profile tree does not contain the "${entryId}" entry — the patch mount is broken`, dump.stdout)
}

// Phase 2 — boot proof: the plugin tree must LOAD without a loader error.
// The observer's last sample now fires at 8s after it starts (SAMPLES above),
// and SIGKILL lands at bootSeconds (25s). That leaves ~17s of headroom so a
// cold start delaying the observer's apply() cannot make the kill fall before
// the last sample; wall-clock cost is unchanged. Last two samples (6s / 8s)
// stay 2s apart.
const bootSeconds = 25
const boot = dsh(['--profile', 'smoke'], {
  timeout: bootSeconds * 1000,
  killSignal: 'SIGKILL',
  env: { ...process.env, DSH_HOME: home, DCP_SMOKE_OBS_FILE: obsFile },
})
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

// A silent, surviving boot is not enough: assert the plugin actually activated.
assertActivation(readObservation(obsFile, output), output)

console.log(`smoke-boot: PASS — ${ownName} mounted via cordis.patch.yml (compaction-basic disabled), composed into the scratch profile tree, booted clean in real dsh (${boot.signal === 'SIGKILL' ? `survived ${bootSeconds}s boot window` : `exited ${boot.status}`}), activated (DcpEngine state=2, /dcp registered); setup mount → remove lifecycle restored the stock tree`)
rmSync(work, { recursive: true, force: true })
rmSync(observerDir, { recursive: true, force: true })
