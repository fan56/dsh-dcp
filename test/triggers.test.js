import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { DcpEngine } from '../lib/index.js'

/**
 * Cordis-shaped context that keeps every registered listener reachable, so
 * tests can fire `session/event` / `agent/status` exactly like the live app.
 */
function listenerCtx() {
  const listeners = new Map()
  const commands = []
  const warnings = []
  return {
    __listeners: listeners,
    __warnings: warnings,
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => listeners.get(name).splice(listeners.indexOf(handler), 1)
    },
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
    commands: { register: (command) => { commands.push(command); return () => {} } },
    logger: { info: () => {}, warn: (text) => warnings.push(text) },
    tokenMeter: { estimateMessage: () => 0 },
    __commands: commands,
  }
}

/** Engine whose compactNow is intercepted instead of driving the region machinery. */
class RoundSpyEngine extends DcpEngine {
  compactNowCalls = 0
  nextResult = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234, summarySeq: 9 }
  nextError = null

  async compactNow(agent, signal, sourceCommandId) {
    this.compactNowCalls += 1
    if (this.nextError !== null) throw this.nextError
    return this.nextResult
  }
}

/** Session double: header id + a recording append(). */
function fakeSession(id) {
  return {
    header: { id },
    appended: [],
    append(type, data) { this.appended.push({ type, data }) },
  }
}

const fire = (ctx, name, ...args) => ctx.__listeners.get(name)?.forEach((handler) => handler(...args))
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

function armedEngine(config) {
  const ctx = listenerCtx()
  return { ctx, engine: new RoundSpyEngine(ctx, config) }
}

test('round trigger compacts at the first idle boundary after N completed turns', async () => {
  const agent = { session: fakeSession('s1'), options: {} }
  const { ctx, engine } = armedEngine({ roundInterval: 2 })
  const idle = async () => {
    fire(ctx, 'agent/status', { agent, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  fire(ctx, 'session/event', agent.session, turnEnd(1))
  await idle()
  assert.equal(engine.compactNowCalls, 0)
  fire(ctx, 'session/event', agent.session, turnEnd(2))
  await idle()
  assert.equal(engine.compactNowCalls, 1)
  // The boundary was consumed: no new completed turns, no second compaction.
  await idle()
  assert.equal(engine.compactNowCalls, 1)
  // A fresh full interval is required before the next one.
  fire(ctx, 'session/event', agent.session, turnEnd(3))
  await idle()
  assert.equal(engine.compactNowCalls, 1)
  fire(ctx, 'session/event', agent.session, turnEnd(4))
  await idle()
  assert.equal(engine.compactNowCalls, 2)
})

test('only completed turns count towards the interval', async () => {
  const agent = { session: fakeSession('s2'), options: {} }
  const { ctx, engine } = armedEngine({ roundInterval: 1 })
  fire(ctx, 'session/event', agent.session, turnEnd(1, 'aborted'))
  fire(ctx, 'session/event', agent.session, turnEnd(1, 'error'))
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  assert.equal(engine.compactNowCalls, 0)
  fire(ctx, 'session/event', agent.session, turnEnd(2))
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  assert.equal(engine.compactNowCalls, 1)
})

test('busy keeps the boundary for the next idle; other failures release it', async () => {
  const agent = { session: fakeSession('s3'), options: {} }
  const { ctx, engine } = armedEngine({ roundInterval: 1 })
  fire(ctx, 'session/event', agent.session, turnEnd(1))

  engine.nextError = new ManualCompactionError('busy', 'x')
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await Promise.resolve()
  assert.equal(engine.compactNowCalls, 1)
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await Promise.resolve()
  assert.equal(engine.compactNowCalls, 2, 'busy retries at the next idle boundary')

  engine.nextError = new Error('summary exploded')
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.compactNowCalls, 3)
  assert.ok(ctx.__warnings.some((text) => text.includes('summary exploded')))
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.compactNowCalls, 3, 'unexpected failure releases the boundary')
})

test('sessions count independently — a subagent sibling does not fire the parent', async () => {
  const parent = { session: fakeSession('parent'), options: {} }
  const child = { session: fakeSession('child'), options: {} }
  const ctx = listenerCtx()
  const engine = new RoundSpyEngine(ctx, { roundInterval: 2 })
  const idle = async (agent) => {
    fire(ctx, 'agent/status', { agent, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  fire(ctx, 'session/event', parent.session, turnEnd(1))
  fire(ctx, 'session/event', child.session, turnEnd(1))
  await idle(child)
  assert.equal(engine.compactNowCalls, 0, 'child is only at round 1 of 2')
  fire(ctx, 'session/event', child.session, turnEnd(2))
  await idle(child)
  assert.equal(engine.compactNowCalls, 1, 'child reached its own interval')
  await idle(parent)
  assert.equal(engine.compactNowCalls, 1, 'parent still at round 1 of 2')
})

test('roundInterval 0 (explicit off) and auto: false never trigger', async () => {
  const agent = { session: fakeSession('s4'), options: {} }
  const off = armedEngine({ roundInterval: 0 })
  for (let turn = 1; turn <= 5; turn += 1) fire(off.ctx, 'session/event', agent.session, turnEnd(turn))
  fire(off.ctx, 'agent/status', { agent, status: 'idle' })
  assert.equal(off.engine.compactNowCalls, 0)

  const manual = armedEngine({ roundInterval: 1, auto: false })
  assert.equal(manual.ctx.__listeners.has('session/event'), false)
})

test('recordCompaction appends a bounded notice row and bumps /dcp stats', () => {
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { language: 'zh' })
  const session = fakeSession('s6')
  engine.recordCompaction(session, { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 23456 }, 'auto')
  assert.equal(engine.dcpStats.compactions, 1)
  assert.equal(engine.dcpStats.shadowedTokens, 23456)
  assert.equal(session.appended.length, 1)
  const { type, data } = session.appended[0]
  assert.equal(type, 'user/message')
  assert.equal(data.source.kind, 'plugin')
  assert.equal(data.source.plugin, 'dsh-dcp')
  assert.equal(data.source.form, 'notice')
  assert.ok(data.source.summary.includes('3'))
  assert.ok(data.source.summary.includes('23456'))
  assert.ok(data.source.summary.length <= 120)
})

test('notice: false records stats without appending; append failures never propagate', () => {
  const quiet = new DcpEngine(listenerCtx(), { notice: false })
  const session = fakeSession('s7')
  quiet.recordCompaction(session, { shadowedSeqs: [1], shadowedTokenCount: 10 }, 'round')
  assert.equal(quiet.dcpStats.compactions, 1)
  assert.equal(session.appended.length, 0)

  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, {})
  const hostile = { header: { id: 's8' }, append: () => { throw new Error('session closed') } }
  engine.recordCompaction(hostile, { shadowedSeqs: [1], shadowedTokenCount: 10 }, 'manual')
  assert.equal(engine.dcpStats.compactions, 1)
  assert.ok(ctx.__warnings.some((text) => text.includes('notice append failed')))
})

// ---------------------------------------------------------------------------
// Real-override coverage: stub BasicCompactionEngine's prototype methods so
// DcpEngine's own overrides (label routing, stats, notice, counter release)
// run for real without the upstream region machinery.

/** Run fn with one BasicCompactionEngine method stubbed, restoring after. */
async function withStubbedSuper(name, stub, fn) {
  const proto = BasicCompactionEngine.prototype
  const original = proto[name]
  proto[name] = stub
  try {
    return await fn()
  } finally {
    proto[name] = original
  }
}

const fakeResult = () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 777, summarySeq: 5 })

test('real compactNow override: round label reaches the notice; counter is consumed', async () => {
  const agent = { session: fakeSession('r1'), options: {} }
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { roundInterval: 1, language: 'zh' })
  const calls = { superCompactNow: 0 }
  await withStubbedSuper('compactNow', async () => {
    calls.superCompactNow += 1
    return fakeResult()
  }, async () => {
    fire(ctx, 'session/event', agent.session, turnEnd(1))
    fire(ctx, 'agent/status', { agent, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(calls.superCompactNow, 1)
  assert.equal(engine.dcpStats.compactions, 1)
  assert.equal(engine.dcpStats.shadowedTokens, 777)
  assert.equal(agent.session.appended.length, 1)
  assert.ok(agent.session.appended[0].data.source.summary.includes('round'))
  // Counter consumed by the committed compaction: no re-trigger without a new turn.
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.superCompactNow, 1)
})

test('real compactNow override: direct call labels manual and appends its notice', async () => {
  const agent = { session: fakeSession('r2'), options: {} }
  const engine = new DcpEngine(listenerCtx(), { roundInterval: 5 })
  await withStubbedSuper('compactNow', async () => fakeResult(), async () => {
    await engine.compactNow(agent, new AbortController().signal)
  })
  assert.equal(engine.dcpStats.compactions, 1)
  assert.ok(agent.session.appended[0].data.source.summary.includes('manual'))
})

test('real compactNow override: null result releases the round counter without a notice', async () => {
  const agent = { session: fakeSession('r3'), options: {} }
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { roundInterval: 1 })
  const calls = { superCompactNow: 0 }
  await withStubbedSuper('compactNow', async () => {
    calls.superCompactNow += 1
    return null
  }, async () => {
    fire(ctx, 'session/event', agent.session, turnEnd(1))
    fire(ctx, 'agent/status', { agent, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(calls.superCompactNow, 1)
  assert.equal(engine.dcpStats.compactions, 0)
  assert.equal(agent.session.appended.length, 0)
  // Null released the boundary: no compactable history, so idle alone must not loop.
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.superCompactNow, 1)
})

test('real compactRegion override: records stats only, no per-region notice', async () => {
  const agent = { session: fakeSession('r4'), options: {} }
  const engine = new DcpEngine(listenerCtx(), {})
  await withStubbedSuper('compactRegion', async () => fakeResult(), async () => {
    await engine.compactRegion(1, 3, agent)
  })
  assert.equal(engine.dcpStats.compactions, 1)
  assert.equal(engine.dcpStats.shadowedTokens, 777)
  assert.equal(agent.session.appended.length, 0, 'notices belong to the trigger layer, not each region')
})

test('real compactIfNeeded override: one notice per trigger event, labeled by kind', async () => {
  const agent = { session: fakeSession('r5'), options: {} }
  const engine = new DcpEngine(listenerCtx(), {})
  await withStubbedSuper('compactIfNeeded', async () => fakeResult(), async () => {
    await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  })
  assert.ok(agent.session.appended[0].data.source.summary.includes('auto'))
  await withStubbedSuper('compactIfNeeded', async () => fakeResult(), async () => {
    await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
  })
  assert.ok(agent.session.appended[1].data.source.summary.includes('overflow'))
  await withStubbedSuper('compactIfNeeded', async () => null, async () => {
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    assert.equal(result, null)
  })
  assert.equal(agent.session.appended.length, 2, 'null trigger result appends no notice')
})

test('cancelled round compaction keeps the accumulated rounds for the next idle', async () => {
  const agent = { session: fakeSession('r6'), options: {} }
  const { ctx, engine } = armedEngine({ roundInterval: 1 })
  fire(ctx, 'session/event', agent.session, turnEnd(1))
  engine.nextError = new ManualCompactionError('cancelled', 'x')
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.compactNowCalls, 1)
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(engine.compactNowCalls, 2, 'cancelled retries at the next idle boundary')
})
