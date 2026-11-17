import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BASIC_CONFIG_KEYS } from '../lib/config.js'

// BasicCompactionEngine.Config is a schemastery Schema (a function), not a
// plain object: its declared fields live on `.dict`. splitConfig() forwards
// exactly these keys to the parent and throws on anything unknown, so a key
// added upstream but absent here becomes a runtime "unknown key" for users.
const parentConfigKeys = Object.keys(/** @type {any} */ (BasicCompactionEngine.Config).dict)

test('BASIC_CONFIG_KEYS covers every BasicCompactionEngine.Config key', () => {
  assert.ok(parentConfigKeys.length > 0,
    'could not collect keys from BasicCompactionEngine.Config.dict — schemastery schema shape changed; update this guard, do not skip it')
  const missing = parentConfigKeys.filter((key) => !BASIC_CONFIG_KEYS.includes(key))
  assert.deepEqual(missing, [],
    `BASIC_CONFIG_KEYS is missing parent Config keys (compaction-basic grew): ${missing.join(', ')} — extend BASIC_CONFIG_KEYS in lib/config.js`)
})

test('BASIC_CONFIG_KEYS has no duplicate keys', () => {
  const duplicates = BASIC_CONFIG_KEYS.filter((key, i) => BASIC_CONFIG_KEYS.indexOf(key) !== i)
  assert.deepEqual(duplicates, [],
    `BASIC_CONFIG_KEYS contains duplicate entries: ${duplicates.join(', ')}`)
})
