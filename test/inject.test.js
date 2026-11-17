import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DcpEngine } from '../lib/index.js'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

// Cordis merges a decorator-built inject object along the prototype chain, but an
// array inject is a full replacement. Collect names from either shape.
const injectNames = (inj) => {
  if (!inj) return []
  if (Array.isArray(inj)) return [...inj]
  const names = []
  for (let obj = inj; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    names.push(...Object.keys(obj))
  }
  return names
}

test('BasicCompactionEngine.inject resolves the core services', () => {
  const names = injectNames(BasicCompactionEngine.inject)
  const missing = ['llm', 'tokenMeter', 'sessions'].filter((n) => !names.includes(n))
  assert.deepEqual(missing, [],
    `BasicCompactionEngine.inject must resolve llm/tokenMeter/sessions; missing: ${missing.join(', ')} — otherwise the inject coverage assertions are vacuous`)
})

test('DcpEngine inject covers every inherited BasicCompactionEngine entry', () => {
  const child = new Set(injectNames(DcpEngine.inject))
  const missing = injectNames(BasicCompactionEngine.inject).filter((n) => !child.has(n))
  assert.deepEqual(missing, [],
    `static inject is missing inherited entries (compaction-basic grew): ${missing.join(', ')} — extend the array at lib/index.js`)
})

test('DcpEngine keeps its own commands/skills entries', () => {
  const child = new Set(injectNames(DcpEngine.inject))
  assert.ok(child.has('commands') && child.has('skills'))
})
