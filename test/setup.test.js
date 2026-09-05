import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPatch, planRemoval, mountBlock, isMounted, hasEntry, backupStamp, findBundledProfiles } from '../lib/setup.js'

const NAME = '/x/node_modules/@aiwayds/dsh-dcp/lib/index.js'

test('planPatch on a missing file returns create with disable + insert', () => {
  const plan = planPatch(undefined, { name: NAME })
  assert.equal(plan.action, 'create')
  assert.ok(plan.block.includes('- id: compaction-basic'))
  assert.ok(plan.block.includes('disabled: true'))
  assert.ok(plan.block.includes(`- insert:`))
  assert.ok(plan.block.includes(`name: ${NAME}`))
})

test('planPatch on an empty file patches with both entries', () => {
  const plan = planPatch('', { name: NAME })
  assert.equal(plan.action, 'patch')
  assert.ok(plan.block.includes('id: compaction-basic'))
  assert.ok(plan.block.includes('id: dsh-dcp'))
})

test('planPatch skips when dsh-dcp is already mounted', () => {
  const text = `- id: anysearch\n  name: '@deepseek-ai/dsh-mcp-client'\n\n- insert:\n    - id: dsh-dcp\n      name: '@aiwayds/dsh-dcp'\n`
  assert.equal(planPatch(text, { name: NAME }).action, 'skip')
})

test('planPatch never duplicates an existing compaction-basic entry', () => {
  const text = `- id: compaction-basic\n  disabled: true\n`
  const plan = planPatch(text, { name: NAME })
  assert.equal(plan.action, 'patch')
  assert.ok(!plan.block.includes('id: compaction-basic'), 'must not re-add the disable entry')
  assert.ok(plan.block.includes('id: dsh-dcp'))
  assert.ok(plan.note, 'must warn about the existing compaction-basic entry')
})

test('mountBlock appends cleanly after existing content (append-only)', () => {
  const original = `# my comment\n- id: anysearch\n  name: x\n`
  const plan = planPatch(original, { name: NAME })
  const merged = original + (/** @type {{action: string, block: string}} */ (plan)).block
  // the user's original content is byte-for-byte intact at the front
  assert.ok(merged.startsWith(original))
  // and the appended block is valid as additional YAML list items
  assert.ok(merged.includes('\n# dsh-dcp'))
  assert.ok(merged.includes('id: dsh-dcp'))
})

test('isMounted and hasEntry are idempotency-safe across indentations', () => {
  assert.ok(isMounted('\n- insert:\n    - id: dsh-dcp\n'))
  assert.ok(isMounted('  - id: dsh-dcp\n'))
  assert.ok(!isMounted('- id: dcp\n'))
  assert.ok(hasEntry('\n- id: compaction-basic\n', 'compaction-basic'))
  assert.ok(!hasEntry('- id: compaction\n', 'compaction-basic'))
})

test('backupStamp is a dated YYYYMMDD-HHMM stamp', () => {
  const stamp = backupStamp(new Date(2026, 7, 18, 9, 5)) // Aug 18 09:05
  assert.equal(stamp, '20260818-0905')
})

test('findBundledProfiles lists profiles that bundle a package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcp-setup-'))
  try {
    mkdirSync(join(dir, 'tui'), { recursive: true })
    mkdirSync(join(dir, 'headless'), { recursive: true })
    writeFileSync(join(dir, 'tui', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@aiwayds/dsh-dcp'] } } }))
    writeFileSync(join(dir, 'headless', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    assert.deepEqual(findBundledProfiles(dir, '@aiwayds/dsh-dcp'), ['tui'])
    assert.deepEqual(findBundledProfiles(dir, '@aiwayds/nope'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- planRemoval: the uninstall reverse of planPatch/mountBlock ----

test('planRemoval undoes planPatch exactly: user content preserved, nothing of ours left', () => {
  const original = `# my comment\n- id: anysearch\n  name: x\n`
  const plan = planPatch(original, { name: NAME })
  const merged = original + (/** @type {{action: string, block: string}} */ (plan)).block
  const removal = planRemoval(merged)
  assert.equal(removal.removed, true)
  assert.equal(removal.text, original)
  assert.ok(!removal.text.includes('dsh-dcp'))
  assert.ok(!removal.text.includes('compaction-basic'), 'the disable entry the setup added must go too')
})

test('planRemoval on a setup-created fresh file leaves empty text (caller deletes the file)', () => {
  const plan = planPatch(undefined, { name: NAME })
  const removal = planRemoval((/** @type {{action: string, block: string}} */ (plan)).block)
  assert.equal(removal.removed, true)
  assert.equal(removal.text, '')
})

test('planRemoval keeps user entries appended AFTER the mount block', () => {
  const mounted = `# mine\n` + mountBlock({ name: NAME, includeDisable: true })
  const merged = mounted + `- id: context7\n  name: '@deepseek-ai/dsh-mcp-client'\n`
  const removal = planRemoval(merged)
  assert.equal(removal.removed, true)
  assert.ok(removal.text.includes('id: context7'))
  assert.ok(!removal.text.includes('dsh-dcp'))
})

test('planRemoval removes the block even when the user tuned config inside the insert item', () => {
  const mounted = mountBlock({ name: NAME, includeDisable: true })
    .replace('thresholdRatio: 0.7', 'thresholdRatio: 0.9')
    .replace('language: zh', 'language: en')
  const removal = planRemoval(`# keep\n${mounted}- id: after\n  name: y\n`)
  assert.equal(removal.removed, true)
  assert.equal(removal.text, '# keep\n- id: after\n  name: y\n')
})

test('planRemoval is idempotent: a second run is a no-op', () => {
  const merged = `# mine\n` + mountBlock({ name: NAME, includeDisable: true })
  const first = planRemoval(merged)
  const second = planRemoval(first.text)
  assert.equal(second.removed, false)
  assert.equal(second.text, first.text)
})

test('planRemoval leaves hand-written mounts (no setup marker) untouched', () => {
  const handWritten = `- insert:\n    - id: dsh-dcp\n      name: '/some/absolute/path/lib/index.js'\n`
  const removal = planRemoval(handWritten)
  assert.equal(removal.removed, false)
  assert.equal(removal.text, handWritten)
  assert.ok(removal.note)
})

test('planRemoval on undefined/empty text is a no-op', () => {
  assert.equal(planRemoval(undefined).removed, false)
  assert.equal(planRemoval('').removed, false)
})

test('mountBlock writes the compaction-basic name guard so a host rename cannot silently disable an unrelated row', () => {
  const block = mountBlock({ name: NAME, includeDisable: true })
  assert.ok(block.includes("name: '@deepseek-ai/dsh-compaction-basic'"))
})
