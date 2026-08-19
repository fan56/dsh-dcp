import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { executeDcp } from '../lib/command.js'

function mockEngine() {
  return {
    dcp: { dedup: true, purgeErrors: true, maxItems: 10, maxItemChars: 200, maxSummaryTokens: 2048, language: 'en', tokenEstimate: 'cjk', protectedTools: [], roundInterval: 50, notice: true },
    config: Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16 }),
    dcpStats: { compactions: 2, shadowedTokens: 1234, lastAt: null },
    pluginPath: '/x/dsh-dcp/lib/index.js',
  }
}

const invocation = (rawInput, extra = {}) => ({
  rawInput, agent: {}, signal: new AbortController().signal, commandId: 'cmd1', ...extra,
})

const identityCtx = () => ({ compaction: { compactNow: async () => null } })

test('/dcp with no arguments shows status', async () => {
  const result = await executeDcp(identityCtx(), invocation(''), mockEngine(), '1.2.3')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('dsh-dcp 1.2.3'))
  assert.ok(result.text.includes('dedup=true'))
  assert.ok(result.text.includes('2 compactions'))
  assert.ok(result.text.includes('1234 tokens shadowed'))
})

test('/dcp help and unknown subcommands', async () => {
  const help = await executeDcp(identityCtx(), invocation('help'), mockEngine(), '1.2.3')
  assert.ok(help.text.includes('/dcp compact'))
  const unknown = await executeDcp(identityCtx(), invocation('frobnicate'), mockEngine(), '1.2.3')
  assert.equal(unknown.kind, 'error')
  assert.ok(unknown.text.includes('unknown subcommand'))
})

test('/dcp set adjusts booleans, numbers, language, thresholdRatio', async () => {
  const engine = mockEngine()
  assert.equal((await executeDcp(identityCtx(), invocation('set dedup off'), engine, 'v')).kind, 'success')
  assert.equal(engine.dcp.dedup, false)
  await executeDcp(identityCtx(), invocation('set dedup on'), engine, 'v')
  assert.equal(engine.dcp.dedup, true)
  await executeDcp(identityCtx(), invocation('set maxItems 5'), engine, 'v')
  assert.equal(engine.dcp.maxItems, 5)
  await executeDcp(identityCtx(), invocation('set language zh'), engine, 'v')
  assert.equal(engine.dcp.language, 'zh')
  await executeDcp(identityCtx(), invocation('set tokenEstimate ascii'), engine, 'v')
  assert.equal(engine.dcp.tokenEstimate, 'ascii')
  const badMode = await executeDcp(identityCtx(), invocation('set tokenEstimate auto'), engine, 'v')
  assert.equal(badMode.kind, 'error')
  await executeDcp(identityCtx(), invocation('set thresholdRatio 0.7'), engine, 'v')
  assert.equal(engine.config.thresholdRatio, 0.7)
})

test('/dcp set adjusts roundInterval and notice', async () => {
  const engine = mockEngine()
  await executeDcp(identityCtx(), invocation('set roundInterval 100'), engine, 'v')
  assert.equal(engine.dcp.roundInterval, 100)
  const disable = await executeDcp(identityCtx(), invocation('set roundInterval 0'), engine, 'v')
  assert.equal(disable.kind, 'success')
  assert.ok(disable.text.includes('disabled'))
  assert.equal(engine.dcp.roundInterval, 0)
  const bad = await executeDcp(identityCtx(), invocation('set roundInterval -1'), engine, 'v')
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('0 or a positive integer'))
  await executeDcp(identityCtx(), invocation('set notice off'), engine, 'v')
  assert.equal(engine.dcp.notice, false)
  const status = await executeDcp(identityCtx(), invocation(''), engine, 'v')
  assert.ok(status.text.includes('roundInterval=0'))
  assert.ok(status.text.includes('notice=false'))
})

test('/dcp set rejects bad input and guards retainRatio', async () => {
  const engine = mockEngine()
  const badKey = await executeDcp(identityCtx(), invocation('set nope 1'), engine, 'v')
  assert.equal(badKey.kind, 'error')
  assert.ok(badKey.text.includes('unknown key'))
  const badValue = await executeDcp(identityCtx(), invocation('set maxItems zero'), engine, 'v')
  assert.equal(badValue.kind, 'error')
  const badRatio = await executeDcp(identityCtx(), invocation('set thresholdRatio 0.1'), engine, 'v')
  assert.equal(badRatio.kind, 'error')
  assert.ok(badRatio.text.includes('retainRatio'))
  assert.equal(engine.config.thresholdRatio, 0.8)
})

test('/dcp set output includes a persistence snippet', async () => {
  const result = await executeDcp(identityCtx(), invocation('set dedup off'), mockEngine(), 'v')
  assert.ok(result.text.includes('cordis.patch.yml'))
  assert.ok(result.text.includes('/x/dsh-dcp/lib/index.js'))
  assert.ok(result.text.includes('dedup: off'))
})

test('/dcp compact maps results and classified failures', async () => {
  const ok = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 999, summarySeq: 42 }
  const withResult = await executeDcp(
    { compaction: { compactNow: async () => ok } }, invocation('compact'), mockEngine(), 'v',
  )
  assert.equal(withResult.kind, 'success')
  assert.ok(withResult.text.includes('3 history items'))
  assert.ok(withResult.text.includes('no LLM call'))
  assert.equal(withResult.sourceEventSeq, 42)

  const nullResult = await executeDcp(identityCtx(), invocation('compact'), mockEngine(), 'v')
  assert.ok(nullResult.text.includes('No compactable history'))

  const busy = await executeDcp(
    { compaction: { compactNow: async () => { throw new ManualCompactionError('busy', 'x') } } },
    invocation('compact'), mockEngine(), 'v',
  )
  assert.equal(busy.kind, 'error')
  assert.ok(busy.text.includes('not idle'))

  const cancelled = await executeDcp(
    { compaction: { compactNow: async () => { throw new ManualCompactionError('cancelled', 'x') } } },
    invocation('compact', { signal: AbortSignal.abort() }), mockEngine(), 'v',
  )
  assert.equal(cancelled.kind, 'error')
  assert.ok(cancelled.text.includes('cancelled'))
})
