/**
 * dsh-dcp setup — safe patching of a user's cordis.patch.yml.
 *
 * The user's file may already carry their own entries (and comments), so this
 * never parses-and-rewrites the whole document: it only APPENDS the dsh-dcp
 * mount block, and only when the mount is not already present. An existing
 * file is backed up (date-stamped) before any change; a missing file is
 * generated fresh.
 *
 * @module dsh-dcp/setup
 */
import { readdirSync, readFileSync } from 'node:fs'

/** The patch entry that disables the default LLM summarizer. */
const DISABLE_ENTRY = `- id: compaction-basic
  disabled: true`

/** The dsh-dcp mount block, one YAML list item, appended to the file. */
export function mountBlock({ name, includeDisable }) {
  const parts = []
  if (includeDisable) parts.push(DISABLE_ENTRY)
  parts.push(`- insert:
    - id: dsh-dcp
      name: ${name}
      config:
        thresholdRatio: 0.7
        language: zh`)
  return '\n# dsh-dcp — deterministic compaction backend (added by @aiwayds/dsh-dcp setup).\n' + parts.join('\n') + '\n'
}

/** Whether the given patch text already mounts dsh-dcp (idempotency guard). */
export function isMounted(text) {
  return /(^|\n)\s*-\s+id:\s*dsh-dcp\b/.test(text)
}

/** Whether the patch text already has an entry with the given id. */
export function hasEntry(text, id) {
  return new RegExp(`(^|\\n)\\s*-\\s+id:\\s*${id}\\b`).test(text)
}

/**
 * Profiles under `profilesDir` that already bundle the given package (so a
 * home-patch mount of the same package would duplicate its entry id).
 * @param {string} profilesDir - `$DSH_HOME/profiles`.
 * @param {string} pkg - package name, e.g. '@aiwayds/dsh-dcp'.
 * @returns {string[]} profile names that bundle it.
 */
export function findBundledProfiles(profilesDir, pkg) {
  if (!profilesDir || !pkg) return []
  let names
  try {
    names = readdirSync(profilesDir)
  } catch {
    return []
  }
  const bundled = []
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(`${profilesDir}/${name}/package.json`, 'utf8'))
      if (manifest?.dsh?.profile?.bundles?.includes(pkg)) bundled.push(name)
    } catch { /* not a profile dir / unreadable manifest */ }
  }
  return bundled
}

/**
 * Decide what to do for one target patch file.
 *
 * @param {string|undefined} text - existing file content, or undefined when the file is absent.
 * @param {{ name: string }} options - the resolvable dsh-dcp entry specifier to mount.
 * @returns {{ action: 'create'|'patch'|'skip', block?: string, note?: string }}
 */
export function planPatch(text, { name }) {
  if (text === undefined || text === null) {
    return { action: 'create', block: mountBlock({ name, includeDisable: true }) }
  }
  if (isMounted(text)) {
    return { action: 'skip' }
  }
  const alreadyHasBasic = hasEntry(text, 'compaction-basic')
  if (alreadyHasBasic) {
    return {
      action: 'patch',
      block: mountBlock({ name, includeDisable: false }),
      note: 'compaction-basic already has an entry in this file; make sure it is disabled, otherwise two backends would both register.',
    }
  }
  return { action: 'patch', block: mountBlock({ name, includeDisable: true }) }
}

/** Date-stamped backup suffix, e.g. `.bak.20260818-1130`. */
export function backupStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}
