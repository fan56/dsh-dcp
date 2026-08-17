import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitConfig, resolveDcpConfig, RUNTIME_SETTABLE } from '../lib/config.js'

test('splitConfig forwards basic keys and dcp keys', () => {
  const { basic, dcp } = splitConfig({
    thresholdRatio: 0.7,
    retainRatio: 0.1,
    dedup: false,
    maxItems: 5,
  })
  assert.deepEqual(basic, { thresholdRatio: 0.7, retainRatio: 0.1 })
  assert.deepEqual(dcp, { dedup: false, maxItems: 5 })
})

test('splitConfig rejects unknown keys', () => {
  assert.throws(() => splitConfig({ dedupx: true }), /unknown key "dedupx"/)
})

test('resolveDcpConfig fills defaults and freezes', () => {
  const resolved = resolveDcpConfig({})
  assert.equal(resolved.dedup, true)
  assert.equal(resolved.purgeErrors, true)
  assert.equal(resolved.maxItems, 10)
  assert.equal(resolved.maxItemChars, 200)
  assert.equal(resolved.maxSummaryTokens, 2048)
  assert.equal(resolved.language, 'en')
  assert.throws(() => { resolved.dedup = false }, /Cannot assign/)
})

test('resolveDcpConfig validates types', () => {
  assert.throws(() => resolveDcpConfig({ dedup: 'yes' }), /dedup must be a boolean/)
  assert.throws(() => resolveDcpConfig({ language: 'fr' }), /language/)
  assert.throws(() => resolveDcpConfig({ maxItems: 0 }), /maxItems/)
  assert.throws(() => resolveDcpConfig({ maxItemChars: 1.5 }), /maxItemChars/)
})

test('runtime settable keys are a closed documented set', () => {
  assert.deepEqual(Object.keys(RUNTIME_SETTABLE).sort(), [
    'dedup', 'language', 'maxItemChars', 'maxItems', 'maxSummaryTokens', 'purgeErrors', 'thresholdRatio',
  ])
})
