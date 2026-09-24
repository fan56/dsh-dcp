import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DcpEngine } from '../lib/index.js'
import { splitConfig } from '../lib/config.js'

/**
 * dsh 0.1.7-rc.1 compaction-basic adaptation tests.
 *
 * compaction-basic grew a REQUIRED `RegionDependencies.recover(error, agent,
 * sourceEventSeqs, signal?): boolean` member and made `resolveCompactSpec`
 * take a required third `reservedCompletionTokens` argument (official sources:
 * packages/compaction/compaction-basic/src/index.ts — `regionDependencies`
 * wires recover to the synchronous `compaction/summary-error` waterfall with
 * default `() => false`, and `reservedCompletionTokens(agent, defaultMaxTokens)`
 * resolves the reservation from `session.requestHeader()?.config.maxTokens`,
 * falling back to the adapter default, then zero). DcpEngine overrides only
 * `summarize()`, so it inherits both wires verbatim — these tests pin the
 * inherited seams so a future override or upstream reshuffle cannot silently
 * drop them.
 */

/** Minimal cordis-shaped context with the seams the pressure path touches. */
function mockCtx() {
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
    get: () => undefined,
    tokenMeter: {
      estimateMessage: () => 0,
      measure: () => ({ totalTokens: 0, nodes: [] }),
    },
    skills: { registerProvider: () => () => {} },
  }
}

const region = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'fix the redirect bug' }], source: { kind: 'user' } },
]

test('regionDependencies exposes the official meter/summarize/recover seam', async () => {
  const ctx = mockCtx()
  const engine = new DcpEngine(ctx, {})
  const dependencies = Reflect.get(engine, 'regionDependencies').bind(engine)()
  assert.equal(dependencies.meter, ctx.tokenMeter)
  // summarize delegates to dcp's deterministic override
  const result = await dependencies.summarize({ messages: region }, { session: {} })
  assert.equal(result.provider, 'dsh-dcp')
  assert.equal(typeof dependencies.recover, 'function')
})

test('recover fires compaction/summary-error with the official payload and defaults false', async () => {
  const calls = []
  const ctx = mockCtx()
  ctx.waterfall = (event, payload, next) => {
    calls.push({ event, payload })
    return next()
  }
  const engine = new DcpEngine(ctx, {})
  const session = { seq: 0 }
  const agent = { session }
  const error = new Error('summarization exploded')
  // regionDependencies is private upstream; Reflect keeps checkJs honest
  const dependencies = Reflect.get(engine, 'regionDependencies').bind(engine)()
  const decision = dependencies.recover(error, agent, [4, 5, 6])
  assert.equal(decision, false, 'no recovery listener recorded durable progress → rethrow upstream')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].event, 'compaction/summary-error')
  assert.equal(calls[0].payload.session, session)
  assert.equal(calls[0].payload.error, error)
  assert.deepEqual(calls[0].payload.sourceEventSeqs, [4, 5, 6])
  assert.ok(!('signal' in calls[0].payload), 'official payload omits the signal key when none was given')
})

test('recover returns the waterfall decision and passes the signal through', () => {
  const ctx = mockCtx()
  ctx.waterfall = (event, payload, next) => payload.sourceEventSeqs.length > 0
  const engine = new DcpEngine(ctx, {})
  const agent = { session: { seq: 0 } }
  const controller = new AbortController()
  const dependencies = Reflect.get(engine, 'regionDependencies').bind(engine)()
  const payloadSeen = /** @type {any} */ ({})
  ctx.waterfall = (event, payload, next) => {
    payloadSeen.value = payload
    return true
  }
  assert.equal(dependencies.recover(new Error('x'), agent, [1], controller.signal), true)
  assert.equal(payloadSeen.value.signal, controller.signal)
})

test('pressure path feeds resolveCompactSpec its third argument from the routed envelope', async () => {
  const engine = new DcpEngine(mockCtx(), { headroomTokens: 500 })
  const session = {
    seq: 0,
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 300 } }),
  }
  const agent = { session }
  const ctx = /** @type {any} */ (engine).ctx
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 8192 }) }
  // 300 reserved + 500 headroom of the 1000-token window leaves a 200-token
  // pressure budget → threshold floor(min(800, 200)) = 200; below it, no
  // compaction and no error.
  ctx.tokenMeter.measure = () => ({ totalTokens: 199, nodes: [] })
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', undefined), null)
})

test('pressure path throws the official reservation errors when budgets go negative', async () => {
  const engine = new DcpEngine(mockCtx(), { headroomTokens: 700 })
  const session = {
    seq: 0,
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 300 } }),
  }
  const agent = { session }
  const ctx = /** @type {any} */ (engine).ctx
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 8192 }) }
  ctx.tokenMeter.measure = () => ({ totalTokens: 900, nodes: [] })
  await assert.rejects(
    engine.compactIfNeeded(agent, 'pressure', undefined),
    /reserves 300 completion tokens and 700 headroom tokens.*leaving no pressure budget/,
  )
})

test('reservation falls back to the adapter default when the envelope has no cap', async () => {
  const engine = new DcpEngine(mockCtx(), { headroomTokens: 950 })
  const session = {
    seq: 0,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const agent = { session }
  const ctx = /** @type {any} */ (engine).ctx
  // defaultMaxTokens 1000 swallows the whole window → message-budget error
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 1000 }) }
  ctx.tokenMeter.measure = () => ({ totalTokens: 0, nodes: [] })
  await assert.rejects(
    engine.compactIfNeeded(agent, 'pressure', undefined),
    /reserves 1000 completion tokens of its 1000-token context window, leaving no message budget/,
  )
})

test('envelope maxTokens wins over the adapter default', async () => {
  const engine = new DcpEngine(mockCtx(), { headroomTokens: 700 })
  const session = {
    seq: 0,
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 300 } }),
  }
  const agent = { session }
  const ctx = /** @type {any} */ (engine).ctx
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 999 }) }
  ctx.tokenMeter.measure = () => ({ totalTokens: 900, nodes: [] })
  await assert.rejects(
    engine.compactIfNeeded(agent, 'pressure', undefined),
    /reserves 300 completion tokens/,
  )
})

test('headroomTokens (new 0.1.7 policy key) forwards through dcp config to the base engine', () => {
  assert.deepEqual(splitConfig({ headroomTokens: 4096, roundInterval: 10 }).basic, { headroomTokens: 4096 })
  const engine = new DcpEngine(mockCtx(), { headroomTokens: 4096 })
  assert.equal(engine.config.headroomTokens, 4096)
  const resolved = DcpEngine.Config({
    headroomTokens: 4096,
    modelPolicies: [{ provider: 'p', model: 'm', headroomTokens: 1024 }],
  })
  assert.equal(resolved.headroomTokens, 4096)
  assert.equal(resolved.modelPolicies[0].headroomTokens, 1024)
})
