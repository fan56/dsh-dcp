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

/** The patch entry that disables the default LLM summarizer. The `name` is
 *  a guard, not an override: if a future host renames or drops the row, the
 *  entry is skipped with a loader warning instead of silently disabling an
 *  unrelated component (the same pattern dsh-tui-pi's patch uses). */
const DISABLE_ENTRY = `- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
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
 * @returns {{ action: 'create'|'patch', block: string, note?: string } | { action: 'skip' }}
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

/** The marker comment every setup-written mount block starts with. */
const MOUNT_MARKER = 'added by @aiwayds/dsh-dcp setup'

/**
 * Reverse of planPatch/mountBlock: remove the setup-appended dsh-dcp mount
 * block — the marker comment, the disable entry it added, and the insert
 * item including any config the user tuned inside it — from one patch
 * file's text. Hand-written mounts without the marker are NOT touched (the
 * human wrote it; the human removes it); user entries after the block are
 * preserved byte-for-byte.
 *
 * Uninstalling the package without this reverse step leaves the mount
 * pointing at the vanished absolute entry path, which fails the profile's
 * whole boot with a module-not-found error.
 *
 * @param {string|undefined} text - the patch file content.
 * @returns {{ removed: boolean, text: string, note?: string }} `text` with
 *   the block gone ('' when nothing else remains — the caller may delete the
 *   file); `removed: false` leaves `text` untouched and sets `note`.
 */
export function planRemoval(text) {
  if (!text) return { removed: false, text: text ?? '' }
  const lines = text.split('\n')
  const marker = lines.findIndex((line) => line.includes(MOUNT_MARKER))
  if (marker === -1) {
    return { removed: false, text, note: 'no setup-written dsh-dcp mount block found (hand-written mounts are left alone)' }
  }
  let i = marker + 1
  let end = lines.length
  let sawInsert = false
  while (i < lines.length) {
    const line = lines[i]
    if (line === '') { i++; continue }
    if (line.startsWith('- ')) {
      // One top-level list item: the entry line plus its indented body (and
      // any blank lines inside it the user added while tuning config). The
      // split artifact after a final newline is EOF, not a blank to consume.
      let j = i + 1
      while (j < lines.length && (lines[j] === '' ? j < lines.length - 1 : lines[j].startsWith(' ') || lines[j].startsWith('\t'))) j++
      if (line.startsWith('- insert')) {
        sawInsert = true
        end = j
        break
      }
      i = j
      continue
    }
    // Anything else at column 0 (a user comment or entry) ends our block.
    end = i
    break
  }
  if (!sawInsert) {
    return { removed: false, text, note: 'the setup marker was found but the dsh-dcp insert item is missing — leaving the file untouched' }
  }
  let start = marker
  // The block was appended with one leading blank line; take it so repeated
  // mount/unmount cycles do not accumulate blank runs.
  if (start > 0 && lines[start - 1].trim() === '') start -= 1
  const remaining = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
  return { removed: true, text: remaining.trim() === '' ? '' : remaining }
}
