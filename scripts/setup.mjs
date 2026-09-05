#!/usr/bin/env node
/**
 * dsh-dcp setup: mount dsh-dcp into a cordis.patch.yml safely.
 *
 * - defaults to the home patch (`$DSH_HOME/cordis.patch.yml`, usually
 *   `~/.dsh/cordis.patch.yml`); `--profile <name>` targets that profile's
 *   patch; a positional argument targets an explicit file path
 * - backs up an existing file to `<file>.bak.<YYYYMMDD-HHMM>` before touching it
 * - appends only the dsh-dcp mount block — the user's own entries and
 *   comments are never rewritten
 * - idempotent: skips when the mount is already present; never duplicates a
 *   `compaction-basic` entry
 * - refuses to double-mount: if dsh-dcp is already a bundle in any affected
 *   profile, it aborts (use `--force` to override)
 * - generates the file fresh when it does not exist
 * - uses the running package's absolute entry path, so the mount resolves
 *   regardless of how dsh-dcp was installed
 *
 * Usage:
 *   node scripts/setup.mjs                 # home patch
 *   node scripts/setup.mjs --profile tui   # tui profile's patch
 *   node scripts/setup.mjs /path/to/cordis.patch.yml
 *   node scripts/setup.mjs --remove [...]  # reverse: remove the setup-written
 *                                          # mount block (same target forms)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planPatch, planRemoval, hasEntry, isMounted, backupStamp, findBundledProfiles } from '../lib/setup.js'

const PKG = '@aiwayds/dsh-dcp'
const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ENTRY = path.join(pkgRoot, 'lib', 'index.js')

function home() {
  return process.env.DSH_HOME || path.join(process.env.HOME ?? '.', '.dsh')
}

function parseArgs(argv) {
  const force = argv.includes('--force')
  const remove = argv.includes('--remove')
  if (argv.includes('--profile')) {
    const index = argv.indexOf('--profile')
    const name = argv[index + 1]
    if (!name) throw new Error('setup: --profile requires a profile name')
    return { target: path.join(home(), 'profiles', name, 'cordis.patch.yml'), kind: 'profile', profileName: name, force, remove }
  }
  const explicit = argv.find((a) => !a.startsWith('-'))
  if (explicit) return { target: path.resolve(explicit), kind: 'explicit', force, remove }
  return { target: path.join(home(), 'cordis.patch.yml'), kind: 'home', force, remove }
}

const { target, kind, profileName, force, remove } = parseArgs(process.argv.slice(2))

if (remove) {
  const existed = fs.existsSync(target)
  const text = existed ? fs.readFileSync(target, 'utf8') : undefined
  if (!existed) {
    console.log(`no ${target} — nothing to remove.`)
    process.exit(0)
  }
  const plan = planRemoval(text)
  if (!plan.removed) {
    console.log(`dsh-dcp mount not removed from ${target}.`)
    if (plan.note) console.log(`note: ${plan.note}`)
    process.exit(0)
  }
  const backup = `${target}.bak.${backupStamp()}`
  fs.copyFileSync(target, backup)
  console.log(`backup: ${backup}`)
  if (plan.text === '') {
    fs.rmSync(target)
    console.log(`removed ${target} (the file held nothing else)`)
  } else {
    fs.writeFileSync(target, plan.text)
    console.log(`removed the dsh-dcp mount block from ${target}`)
  }
  if (plan.text !== '' && hasEntry(plan.text, 'compaction-basic')) {
    console.warn('WARN: a compaction-basic entry remains in this patch file — the stock LLM summarizer stays disabled; remove that entry by hand if it was only for dsh-dcp.')
  }
  if (plan.text !== '' && isMounted(plan.text)) {
    console.warn('WARN: another dsh-dcp mount remains in this patch file — leaving it alone.')
  }
  console.log('restart dsh to apply.')
  process.exit(0)
}

const existed = fs.existsSync(target)
const text = existed ? fs.readFileSync(target, 'utf8') : undefined
if (!existed) console.log(`no ${target} — will generate a fresh patch file`)

const plan = planPatch(text, { name: ENTRY })
if (plan.action === 'skip') {
  console.log('dsh-dcp is already mounted in this patch file — nothing to do.')
  process.exit(0)
}

// Refuse to double-mount: a home/profile patch applies to the same profile as
// the bundle mechanism would, and two dsh-dcp entries would crash the loader.
let affected = []
if (kind === 'profile') affected = [profileName]
else if (kind === 'home') {
  try {
    affected = findBundledProfiles(path.join(home(), 'profiles'), PKG)
  } catch { /* profiles dir unreadable — proceed */ }
}
if (affected.length > 0 && !force) {
  console.error(`ERROR: dsh-dcp is already a bundle in profile(s): ${affected.join(', ')}.`)
  console.error('Mounting it in the patch file too would duplicate the entry id and crash the loader.')
  console.error(`Remove it from those profiles' bundles (dsh plugin rm ${PKG}), or pass --force to override.`)
  process.exit(1)
}
if (affected.length > 0 && force) {
  console.warn(`WARN: overriding — dsh-dcp is already a bundle in: ${affected.join(', ')}. You are on your own if the loader rejects the duplicate.`)
}

if (plan.note) console.warn(`WARN: ${plan.note}`)
if (existed) {
  // back up the user's file only now that we know we will modify it
  const backup = `${target}.bak.${backupStamp()}`
  fs.copyFileSync(target, backup)
  console.log(`backup: ${backup}`)
}
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.appendFileSync(target, plan.block)
console.log(`${plan.action === 'create' ? 'created' : 'patched'} ${target}`)
console.log('restart dsh, then run /dcp to verify.')
