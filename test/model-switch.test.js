import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { DcpEngine } from '../lib/index.js'
import { modelSwitchNoticeText } from '../lib/summarizer.js'

/**
 * Model-switch watch coverage: `request/context` folding, the recency gate,
 * the `off`/`notice`/`auto` modes, the idle-boundary auto compaction, and
 * per-session independence. The listener ctx / spy engine / fake session
 * doubles mirror triggers.test.js.
 */
function listenerCtx() {
  const listeners = new Map()
  const warnings = []
  return {
    __listeners: listeners,
    __warnings: warnings,
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => { const hs = listeners.get(name); hs.splice(hs.indexOf(handler), 1) }
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
    commands: { register: () => () => {} },
    logger: { info: () => {}, warn: (text) => warnings.push(text) },
    tokenMeter: { estimateMessage: () => 0 },
    skills: { registerProvider() { return () => {} } },
  }
}

class SwitchSpyEngine extends DcpEngine {
  compactNowCalls = 0
  /** @type {Error | null} */
  nextError = null
  /** @type {{shadowedSeqs: number[], shadowedTokenCount: number, summarySeq: number} | null} */
  nextResult = { shadowedSeqs: [1, 2], shadowedTokenCount: 500, summarySeq: 7 }

  /** @returns {Promise<any>} the stubbed result, or rejects with the stubbed error. */
  async compactNow(_agent, _signal, _sourceCommandId) {
    this.compactNowCalls += 1
    if (this.nextError !== null) throw this.nextError
    return this.nextResult
  }
}

function fakeSession(id) {
  return {
    header: { id },
    appended: /** @type {{type: string, data: any}[]} */ ([]),
    append(type, data) { this.appended.push({ type, data }) },
  }
}

const fire = (ctx, name, ...args) => ctx.__listeners.get(name)?.forEach((handler) => handler(...args))
const idle = async (ctx, agent) => {
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const assistantMessage = (turn, step = 1) => ({
  type: 'assistant/message',
  data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'roundtrip' }] } },
})
const route = (provider, model) => ({ type: 'request/context', data: { provider, model } })

/** Fire `count` assistant messages on the session. */
const rounds = (ctx, session, count) => {
  for (let i = 1; i <= count; i += 1) fire(ctx, 'session/event', session, assistantMessage(1, i))
}

test('first request/context seeds the baseline; identical repeats are silent', () => {
  const session = fakeSession('m1')
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, {})
  fire(ctx, 'session/event', session, route('deepseek', 'deepseek-chat'))
  assert.equal(session.appended.length, 0, 'seeding never announces')
  fire(ctx, 'session/event', session, route('deepseek', 'deepseek-chat'))
  assert.equal(session.appended.length, 0, 'same route is not a switch')
})

test('notice mode (default) appends the suggestion row after the recency gate', () => {
  const session = fakeSession('m2')
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, {})
  fire(ctx, 'session/event', session, route('deepseek', 'deepseek-chat'))
  rounds(ctx, session, 12)
  fire(ctx, 'session/event', session, route('openai', 'gpt-x'))
  assert.equal(session.appended.length, 1)
  const { type, data } = session.appended[0]
  assert.equal(type, 'user/message')
  assert.equal(data.source.kind, 'plugin')
  assert.equal(data.source.plugin, 'dsh-dcp')
  assert.equal(data.source.form, 'notice')
  assert.ok(data.source.summary.includes('deepseek/deepseek-chat'))
  assert.ok(data.source.summary.includes('openai/gpt-x'))
  assert.ok(data.source.summary.includes('/dcp compact'))
  assert.equal(engine.compactNowCalls, 0, 'notice mode never compacts')
})

test('switches within 10 rounds of the last compaction are ignored', () => {
  const session = fakeSession('m3')
  const ctx = listenerCtx()
  // notice: false silences the *compaction* rows that recordCompaction would
  // otherwise add to the count; switch rows answer only to onModelSwitch.
  const engine = new SwitchSpyEngine(ctx, { notice: false })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 5)
  fire(ctx, 'session/event', session, route('a', 'm2'))
  assert.equal(session.appended.length, 0, 'gate holds below 10 rounds')
  rounds(ctx, session, 5)
  fire(ctx, 'session/event', session, route('a', 'm3'))
  assert.equal(session.appended.length, 1, 'gate opens at 10 accumulated rounds')
  // A committed compaction restarts the clock: the next switch is gated again.
  engine.recordCompaction(session, { shadowedSeqs: [1], shadowedTokenCount: 10 }, 'manual')
  fire(ctx, 'session/event', session, route('a', 'm4'))
  assert.equal(session.appended.length, 1, 'gate re-arms after a compaction')
})

test('auto mode compacts at the next idle boundary with the model-switch label', async () => {
  const session = fakeSession('m4')
  const agent = { session, options: {} }
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { onModelSwitch: 'auto' })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))
  assert.equal(session.appended.length, 1, 'the auto row announces the switch')
  assert.ok(session.appended[0].data.source.summary.includes('b/m2'))
  // Drive the real DcpEngine.compactNow override (labels, stats, pending
  // bookkeeping) with only the upstream region machinery stubbed out.
  let calls = 0
  await withStubbedSuper('compactNow', async () => {
    calls += 1
    return fakeResult()
  }, async () => {
    await idle(ctx, agent)
  })
  assert.equal(calls, 1)
  assert.equal(engine.dcpStats.compactions, 1)
  assert.equal(session.appended.length, 2, 'the committed compaction appends its own row')
  assert.ok(session.appended[1].data.source.summary.includes('model-switch'))
  await idle(ctx, agent)
  assert.equal(calls, 1, 'the pending mark is consumed')
})

test('auto mode downgrades to notice when auto: false', () => {
  const session = fakeSession('m5')
  const agent = { session, options: {} }
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, { onModelSwitch: 'auto', auto: false })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))
  assert.equal(session.appended.length, 1, 'downgraded to the suggestion row')
  fire(ctx, 'agent/status', { agent, status: 'idle' })
  assert.equal(engine.compactNowCalls, 0)
})

test('off mode is fully silent', () => {
  const session = fakeSession('m6')
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, { onModelSwitch: 'off' })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))
  assert.equal(session.appended.length, 0)
  assert.equal(engine.compactNowCalls, 0)
})

test('provider change alone is a switch; reasoning-model pair changes count too', () => {
  const session = fakeSession('m7')
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, { notice: false })
  fire(ctx, 'session/event', session, route('deepseek', 'deepseek-chat'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('zai', 'deepseek-chat'))
  assert.equal(session.appended.length, 1, 'provider-only change switches')
  engine.recordCompaction(session, { shadowedSeqs: [1], shadowedTokenCount: 10 }, 'manual')
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('zai', 'glm-5'))
  assert.equal(session.appended.length, 2, 'model-only change switches')
})

test('busy keeps the auto compaction pending for the next idle; other failures drop it', async () => {
  const session = fakeSession('m8')
  const agent = { session, options: {} }
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, { onModelSwitch: 'auto' })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))

  engine.nextError = new ManualCompactionError('busy', 'x')
  await idle(ctx, agent)
  assert.equal(engine.compactNowCalls, 1)
  await idle(ctx, agent)
  assert.equal(engine.compactNowCalls, 2, 'busy retries at the next boundary')

  engine.nextError = new Error('summary exploded')
  await idle(ctx, agent)
  assert.equal(engine.compactNowCalls, 3)
  assert.ok(ctx.__warnings.some((text) => text.includes('model-switch compaction failed')))
  await idle(ctx, agent)
  assert.equal(engine.compactNowCalls, 3, 'unexpected failure releases the pending mark')
})

test('the auto compaction and the round trigger share one single-flight per session', async () => {
  const session = fakeSession('m9')
  const agent = { session, options: {} }
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { onModelSwitch: 'auto', roundInterval: 10 })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))

  // One idle boundary, both listeners armed (switch pending + interval met):
  // single-flight lets exactly one of them drive the compaction.
  let calls = 0
  await withStubbedSuper('compactNow', async () => {
    calls += 1
    return fakeResult()
  }, async () => {
    await idle(ctx, agent)
  })
  assert.equal(calls, 1)
  assert.equal(engine.dcpStats.compactions, 1)
  await idle(ctx, agent)
  assert.equal(calls, 1, 'no double compaction on one boundary')
})

test('a manual compact between detection and the next idle satisfies the switch', async () => {
  const session = fakeSession('m10')
  const agent = { session, options: {} }
  const ctx = listenerCtx()
  const engine = new DcpEngine(ctx, { onModelSwitch: 'auto' })
  fire(ctx, 'session/event', session, route('a', 'm1'))
  rounds(ctx, session, 10)
  fire(ctx, 'session/event', session, route('b', 'm2'))

  // A user-driven manual compact lands between detection and the next idle:
  // its committed bookkeeping clears the pending mark (the stale history the
  // switch targeted is already shadowed) and restarts the round clock.
  let calls = 0
  await withStubbedSuper('compactNow', async () => {
    calls += 1
    return fakeResult()
  }, async () => {
    await engine.compactNow(agent, new AbortController().signal)
  })
  assert.equal(calls, 1)
  assert.ok(session.appended.some((row) => row.data.source.summary.includes('manual')))
  await idle(ctx, agent)
  assert.equal(calls, 1, 'the switch compaction was already satisfied')
})

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

const fakeResult = () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 500, summarySeq: 7 })

test('malformed request/context payloads are ignored; subagent sessions fold independently', () => {
  const parent = fakeSession('parent')
  const child = fakeSession('child')
  const ctx = listenerCtx()
  const engine = new SwitchSpyEngine(ctx, {})
  fire(ctx, 'session/event', parent, { type: 'request/context', data: {} })
  fire(ctx, 'session/event', parent, { type: 'request/context' })
  assert.equal(parent.appended.length, 0, 'malformed payloads never announce')

  for (const session of [parent, child]) {
    fire(ctx, 'session/event', session, route('a', 'm1'))
  }
  rounds(ctx, parent, 10)
  fire(ctx, 'session/event', parent, route('b', 'm2'))
  assert.equal(parent.appended.length, 1)
  assert.equal(child.appended.length, 0, 'child has its own route baseline and clock')
})

test('modelSwitchNoticeText covers both modes and both languages, falling back to en', () => {
  const en = modelSwitchNoticeText('en', 'notice', 'a/x', 'b/y')
  assert.ok(en.includes('a/x') && en.includes('b/y') && en.includes('/dcp compact'))
  const zh = modelSwitchNoticeText('zh', 'auto', 'a/x', 'b/y')
  assert.ok(zh.includes('a/x') && zh.includes('b/y') && !zh.includes('/dcp compact'))
  const fallback = modelSwitchNoticeText(/** @type {any} */ ('fr'), 'notice', 'a/x', 'b/y')
  assert.ok(fallback.includes('/dcp compact'))
})
