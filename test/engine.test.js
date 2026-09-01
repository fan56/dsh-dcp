import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DcpEngine, default as defaultExport } from '../lib/index.js'

/** Minimal cordis-shaped context: enough for construction + summarize(). */
function mockCtx() {
  const commands = []
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
    commands: { register: (command) => { commands.push(command); return () => {} } },
    logger: { info: () => {}, warn: () => {} },
    tokenMeter: {
      estimateMessage: (message) => Math.ceil(JSON.stringify(message.content ?? []).length / 4),
    },
    __commands: commands,
  }
}

const filler = (label) => `${label} ${'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(6)}`.slice(0, 400)

const region = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我把登录页的重定向 bug 修掉' }], source: { kind: 'user' } },
  {
    id: 'a1', role: 'assistant',
    content: [
      { type: 'text', text: '查找相关代码' },
      { type: 'tool-call', id: 'c1', name: 'fs.read', arguments: '{"file_path":"/app/login.ts"}' },
    ],
    source: { kind: 'model', provider: 'p', model: 'm' },
  },
  {
    id: 'r1', role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: filler('login.ts:') }] }],
    source: { kind: 'tool', callId: 'c1' },
  },
  {
    id: 'a2', role: 'assistant',
    content: [
      { type: 'text', text: '再看下最近提交' },
      { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"git log --oneline -5"}' },
    ],
    source: { kind: 'model', provider: 'p', model: 'm' },
  },
  {
    id: 'r2', role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: filler('commits:') }] }],
    source: { kind: 'tool', callId: 'c2' },
  },
  {
    id: 'a3', role: 'assistant', content: [{ type: 'text', text: '代码已读完，准备修改。' }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  },
]

test('engine constructs, splits config, and registers /dcp', () => {
  const ctx = mockCtx()
  const engine = new DcpEngine(ctx, { thresholdRatio: 0.7, dedup: false, language: 'zh' })
  assert.equal(engine.config.thresholdRatio, 0.7)
  assert.equal(engine.dcp.dedup, false)
  assert.equal(engine.dcp.language, 'zh')
  assert.equal(engine.dcp.maxItems, 10)
  assert.deepEqual(ctx.__commands.map((command) => command.name), ['dcp'])
  assert.ok(engine.pluginPath.endsWith('lib/index.js'))
})

test('default export is the engine class', () => {
  assert.equal(defaultExport, DcpEngine)
})

test('summarize() runs deterministically with no LLM call', async () => {
  const engine = new DcpEngine(mockCtx(), {})
  const first = await engine.summarize({ messages: region }, { session: {}, options: {} })
  const second = await engine.summarize({ messages: region }, { session: {}, options: {} })
  assert.deepEqual(first, second)
  assert.equal(first.provider, 'dsh-dcp')
  assert.equal(first.model, 'deterministic-v1')
  assert.ok(first.summary[0].text.includes('## Primary Request and Intent'))
  assert.ok(first.summary[0].text.includes('/app/login.ts'))
})

test('summarize() honors abort signals before working', async () => {
  const engine = new DcpEngine(mockCtx(), {})
  await assert.rejects(
    engine.summarize({ messages: region }, { session: {}, options: {} }, AbortSignal.abort()),
    (/** @type {any} */ error) => error.name === 'AbortError',
  )
})

test('constructor rejects unknown config keys loudly', () => {
  assert.throws(() => new DcpEngine(mockCtx(), { dedupx: 1 }), /unknown key/)
})

test('static Config normalization keeps policy and dcp keys intact', () => {
  const resolved = DcpEngine.Config({
    dedup: false,
    maxItems: 5,
    thresholdRatio: 0.7,
    tokenEstimate: 'ascii',
    modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0.1 }],
  })
  assert.equal(resolved.dedup, false)
  assert.equal(resolved.maxItems, 5)
  assert.equal(resolved.thresholdRatio, 0.7)
  assert.equal(resolved.tokenEstimate, 'ascii')
  assert.equal(resolved.modelPolicies[0].provider, 'p')
  assert.equal(resolved.modelPolicies[0].retainRatio, 0.1)
})
