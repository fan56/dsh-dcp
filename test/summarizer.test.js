import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clip,
  parseCheckpointSections,
  extractFacts,
  composeSummary,
  summarizeDeterministically,
  SECTIONS,
} from '../lib/summarizer.js'

/** Minimal message builders matching dsh-llm runtime shapes. */
const user = (text) => ({ id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const checkpoint = (text) => ({
  id: 'c', role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'compact' },
})
const assistant = (blocks) => ({
  id: 'a', role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' },
})
const toolCall = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const toolResult = (callId, lines, isError = false) => ({
  id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: callId, isError, content: lines.map((text) => ({ type: 'text', text })) }], source: { kind: 'tool', callId },
})

/** chars/4 estimator, same shape as the host meter's documented heuristic. */
const estimate = (message) => Math.ceil(JSON.stringify(message.content ?? []).length / 4)
const dcp = { dedup: true, purgeErrors: true, maxItems: 10, maxItemChars: 200, maxSummaryTokens: 2048, language: 'en' }

function sampleRegion() {
  return [
    user('Fix the login page redirect bug and update the README.'),
    assistant([
      { type: 'text', text: 'Reading the auth module first.\n- [ ] add regression test\n- [x] reproduce locally' },
      toolCall('c1', 'fs.read', { file_path: '/app/src/auth/login.ts' }),
    ]),
    toolResult('c1', ['export function login() { … 400 lines … }']),
    assistant([toolCall('c2', 'bash', { command: 'git log --oneline -5' })]),
    toolResult('c2', ['abc123 fix callback\nabc000 init']),
    assistant([toolCall('c3', 'fs.edit', { file_path: '/app/src/auth/login.ts' })]),
    toolResult('c3', ['applied']),
    assistant([
      { type: 'text', text: 'The edit landed; running the same search again to double-check.' },
      toolCall('c4', 'fs.search', { pattern: 'redirect', path: '/app/src' }),
    ]),
    toolResult('c4', ['found 3 matches']),
    assistant([toolCall('c5', 'fs.search', { pattern: 'redirect', path: '/app/src' })]),
    toolResult('c5', ['found 3 matches']),
    assistant([toolCall('c6', 'fs.read', { file_path: '/app/missing/deps.lock' })]),
    toolResult('c6', ['ENOENT: no such file or directory, open \'/app/missing/deps.lock\''], true),
    assistant([{ type: 'text', text: 'Done with the code change; README next.' }]),
  ]
}

test('clip collapses whitespace and caps length', () => {
  assert.equal(clip('a  b\n\t c', 100), 'a b c')
  assert.equal(clip('x'.repeat(50), 10).length, 10)
  assert.ok(clip('x'.repeat(50), 10).endsWith('…'))
})

test('parseCheckpointSections splits prior checkpoints by header', () => {
  const sections = parseCheckpointSections(
    `preamble\n\n<compacted-summary>\n## Primary Request and Intent\n- first\n- second\n\n## Current Work\n- stale\n</compacted-summary>`,
  )
  assert.deepEqual(sections.get('Primary Request and Intent'), ['first', 'second'])
  assert.deepEqual(sections.get('Current Work'), ['stale'])
})

test('extractFacts collects intents, files, commands, errors, todos, dups', () => {
  const facts = extractFacts(sampleRegion())
  assert.equal(facts.messageCount, 14)
  assert.equal(facts.intents.length, 1)
  assert.ok(facts.intents[0].includes('login page redirect'))
  assert.equal(facts.files.get('/app/src/auth/login.ts').reads, 1)
  assert.equal(facts.files.get('/app/src/auth/login.ts').writes, 1)
  assert.deepEqual(facts.commands, ['git log --oneline -5'])
  assert.equal(facts.errors.length, 1)
  assert.ok(facts.errors[0].includes('ENOENT'))
  assert.deepEqual(facts.pendingTodos, ['add regression test'])
  assert.equal(facts.toolCallCount, 6)
  const dup = [...facts.dupCounts.values()].find((entry) => entry.count > 1)
  assert.equal(dup.count, 2)
  assert.equal(dup.name, 'fs.search')
  assert.ok(facts.lastAssistantText.includes('README next'))
})

test('extractFacts carries prior checkpoint sections separately', () => {
  const prior = checkpoint(
    '<compacted-summary>\n## Primary Request and Intent\n- migrate the billing service\n\n## Next Step\n- stale step\n</compacted-summary>',
  )
  const facts = extractFacts([prior, user('continue')])
  assert.deepEqual(facts.carried.get('Primary Request and Intent'), ['migrate the billing service'])
  assert.deepEqual(facts.intents, ['continue'])
})

test('composeSummary renders all sections in canonical order', () => {
  const facts = extractFacts(sampleRegion())
  const text = composeSummary(facts, dcp)
  const headers = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(headers, [
    SECTIONS.intent, SECTIONS.concepts, SECTIONS.files, SECTIONS.errors,
    SECTIONS.todos, SECTIONS.current, SECTIONS.next, SECTIONS.context,
  ])
  assert.ok(text.includes('- /app/src/auth/login.ts — W×1 R×1'))
  assert.ok(text.includes('fs.search'))
  assert.ok(text.includes('ran 2x'))
  assert.ok(text.includes('Next Step') && text.includes('add regression test'))
})

test('composeSummary merges carried checkpoint facts and drops stale ones', () => {
  const prior = checkpoint(
    '<compacted-summary>\n## Primary Request and Intent\n- migrate the billing service\n\n## Files and Code\n- /old/path.ts — R×3\n\n## Current Work\n- stale\n</compacted-summary>',
  )
  const facts = extractFacts([prior, ...sampleRegion()])
  const text = composeSummary(facts, dcp)
  assert.ok(text.includes('migrate the billing service'))
  assert.ok(text.includes('/old/path.ts — R×3'))
  assert.ok(!text.includes('stale'))
  // current work reflects the fresh tail, not the checkpoint
  const currentSection = text.split('## Current Work')[1].split('##')[0]
  assert.ok(currentSection.includes('README next'))
})

test('composeSummary elides old errors when purgeErrors keeps the recent ones', () => {
  const messages = []
  for (let index = 0; index < 15; index += 1) {
    messages.push(assistant([toolCall(`e${index}`, 'bash', { command: `step ${index}` })]))
    messages.push(toolResult(`e${index}`, [`Error ${index}: boom`], true))
  }
  const facts = extractFacts(messages)
  const text = composeSummary(facts, { ...dcp, maxItems: 3 })
  assert.ok(text.includes('Error 14: boom'))
  assert.ok(text.includes('elided'))
  assert.ok(!text.includes('Error 0: boom'))
})

test('summarizeDeterministically is stable and zero-LLM', () => {
  const input = { messages: sampleRegion() }
  const first = summarizeDeterministically(input, dcp, estimate)
  const second = summarizeDeterministically(input, dcp, estimate)
  assert.deepEqual(first, second)
  assert.equal(first.provider, 'dsh-dcp')
  assert.equal(first.model, 'deterministic-v1')
  assert.equal(first.summary.length, 1)
  assert.equal(first.summary[0].type, 'text')
  assert.ok(first.summary[0].text.length > 100)
})

test('summarizeDeterministically degrades to terse output under a tight budget', () => {
  const input = { messages: [...sampleRegion(), ...sampleRegion()] }
  const tight = { ...dcp, maxSummaryTokens: 120 }
  const result = summarizeDeterministically(input, tight, estimate)
  assert.ok(estimate({ role: 'user', content: result.summary, source: { kind: 'user' } }) <= 120 * 1.35)
  assert.ok(result.summary[0].text.includes('dsh-dcp'))
})

test('zh language switches filler text, keeps section anchors', () => {
  const text = composeSummary(extractFacts([user('继续修 bug')]), { ...dcp, language: 'zh' })
  assert.ok(text.includes('（无）'))
  assert.ok(text.includes('## Primary Request and Intent'))
  assert.ok(text.includes('继续修 bug'))
})
