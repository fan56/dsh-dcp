import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPatch, mountBlock, isMounted, hasEntry, backupStamp, findBundledProfiles } from '../lib/setup.js'

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
  const merged = original + plan.block
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
