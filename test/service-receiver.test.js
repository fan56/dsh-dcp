import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { DcpEngine } from '../lib/index.js'
import { executeDcp } from '../lib/command.js'

/**
 * Regression tests for cordis service receivers.
 *
 * cordis hands services to consuming fibers through derived receivers, not
 * the provider's own instance: `ctx.mixin` binds methods to a withProps proxy
 * (target = the calling ctx, service properties overlaid), and
 * `createTraceable` calls them on Object.create-derived shadows. `/compact`
 * and `/dcp compact` both invoke `ctx.compaction.compactNow(...)` through
 * exactly these paths, and before the symbol-key refactor every engine
 * member declared `#private` brand-checked against the derived receiver and
 * threw "Cannot read private member #triggerLabels from an object whose
 * class did not declare it". These tests drive every seam through both
 * receiver shapes and assert state stays shared with the original instance.
 */

/** Minimal cordis-shaped context; `sessions.list` backs sessionStatsOverview(). */
function mockCtx(sessions = []) {
  return {
    on: () => () => {},
    effect: (factory) => {
      const iterator = factory()
      const disposers = []
      let step = iterator.next()
      while (!step.done) {
        disposers.push(step.value)
        step = iterator.next()
      }
      return () => disposers.forEach((dispose) => dispose())
    },
    reflect: { provide: () => {} },
    commands: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {} },
    tokenMeter: { estimateMessage: () => 0 },
    sessions: { list: () => sessions },
  }
}

/** cordis `withProps(receiver, service)` — the ctx.mixin binding target. */
function withProps(target, props) {
  return new Proxy(target, {
    get: (t, p, r) => (p in props && p !== 'constructor' ? Reflect.get(props, p, r) : Reflect.get(t, p, r)),
    set: (t, p, v, r) => (p in props && p !== 'constructor' ? Reflect.set(props, p, v, r) : Reflect.set(t, p, v, r)),
  })
}

/** The two receiver shapes cordis produces for a mounted service. */
function derivedReceivers(engine) {
  return [
    ['mixin withProps proxy', withProps({ callerCtx: true }, engine)],
    ['traceable shadow', Object.create(engine)],
  ]
}

function fakeSession(id) {
  return {
    header: { id },
    appended: /** @type {{type: string, data: any}[]} */ ([]),
    append(type, data) { this.appended.push({ type, data }) },
  }
}

/** An agent without `runMaintenance`: the parent seam rejects it before any region work. */
function fakeAgent(session) {
  return { session, options: {} }
}

test('compactNow passes the trigger-label read on derived receivers', async () => {
  const engine = new DcpEngine(mockCtx(), {})
  const agent = fakeAgent(fakeSession('s1'))
  for (const [label, receiver] of derivedReceivers(engine)) {
    const method = Reflect.get(engine, 'compactNow', receiver).bind(receiver)
    await assert.rejects(
      method(agent, new AbortController().signal),
      (/** @type {any} */ error) => {
        assert.ok(!(error instanceof TypeError), `${label}: ${error.message}`)
        assert.ok(!/private member/.test(error.message), `${label}: ${error.message}`)
        assert.ok(error instanceof ManualCompactionError, `${label}: expected ManualCompactionError, got ${error}`)
        return true
      },
    )
  }
})

test('recordCompaction on derived receivers shares state with the original engine', () => {
  const session = fakeSession('shared')
  const engine = new DcpEngine(mockCtx([session]), {})
  const result = { shadowedSeqs: [1, 2], shadowedTokenCount: 42, summarySeq: 7 }

  let calls = 0
  for (const [label, receiver] of derivedReceivers(engine)) {
    calls += 1
    const record = Reflect.get(engine, 'recordCompaction', receiver).bind(receiver)
    record(session, result, 'manual')
    // The same receiver must read back what all receivers have written so far.
    const overview = Reflect.get(engine, 'sessionStatsOverview', receiver).bind(receiver)()
    assert.equal(overview.length, 1, label)
    assert.equal(overview[0].compactions, calls, label)
    assert.equal(overview[0].shadowedTokens, 42 * calls, label)
  }

  assert.deepEqual(engine.sessionStatsOverview(), [
    { id: 'shared', compactions: 2, shadowedTokens: 84 },
  ])
  assert.equal(engine.dcpStats.compactions, 2)
  assert.equal(engine.dcpStats.shadowedTokens, 84)
  assert.equal(session.appended.length, 2)
  assert.equal(session.appended[0].type, 'user/message')
})

test('compactRegion on derived receivers records stats on the original engine', async () => {
  const engine = new DcpEngine(mockCtx(), {})
  const agent = fakeAgent(fakeSession('region'))
  const calls = []
  // Interpose on the parent seam; symbol-keyed bookkeeping still must land.
  const parent = Object.getPrototypeOf(DcpEngine.prototype)
  const saved = parent.compactRegion
  parent.compactRegion = async () => {
    calls.push('region')
    return { shadowedSeqs: [3], shadowedTokenCount: 5, summarySeq: 9 }
  }
  try {
    for (const [, receiver] of derivedReceivers(engine)) {
      const method = Reflect.get(engine, 'compactRegion', receiver).bind(receiver)
      const result = await method(1, 3, agent)
      assert.equal(result.shadowedTokenCount, 5)
    }
  } finally {
    parent.compactRegion = saved
  }
  assert.equal(calls.length, 2)
  assert.equal(engine.dcpStats.compactions, 2)
  assert.equal(engine.dcpStats.shadowedTokens, 10)
})

test('/dcp compact through a mixin-style ctx.compaction returns a classified failure, not a TypeError', async () => {
  const engine = new DcpEngine(mockCtx(), {})
  // command-compact and /dcp compact read ctx.compaction; the registry hands
  // out derived receivers, so simulate the exact production shape.
  const ctx = mockCtx()
  ctx.compaction = withProps(ctx, engine)
  const invocation = {
    rawInput: 'compact',
    agent: fakeAgent(fakeSession('cmd')),
    signal: new AbortController().signal,
    commandId: undefined,
  }
  const result = await executeDcp(ctx, invocation, engine, 'test')
  assert.equal(result.kind, 'error')
  assert.ok(!/private member/.test(result.text), result.text)
  assert.ok(result.text.length > 0)
})
