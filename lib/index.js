/**
 * dsh-dcp — deterministic context-pruning compaction backend for dsh.
 *
 * Replaces `compaction-basic`'s LLM summarization with a deterministic,
 * template-based checkpoint extractor: zero auxiliary LLM calls per
 * compaction, stable output for identical input, Chinese-friendly trigger
 * tuning via the usual policy keys. Everything else — pressure triggers,
 * retention, overflow recovery, durable transactions, tool-pairing safety —
 * is inherited from `BasicCompactionEngine`, whose `summarize()` is the sole
 * customization seam (see docs/subsystems/compaction.md in deepseek-harness).
 *
 * Design references Opencode-DCP/opencode-dynamic-context-pruning: dedup
 * repeated tool calls, purge stale errors, technical summaries instead of
 * prose, `/dcp` command, defaults that work with no configuration.
 *
 * Mount (home-level patch, `~/.dsh/cordis.patch.yml`):
 *
 * ```yaml
 * - id: compaction-basic
 *   name: /absolute/path/to/dsh-dcp/lib/index.js
 *   config:
 *     thresholdRatio: 0.7   # optional; 0.7 = this bundle patch's mount value, package default is 0.8; every key is optional
 *     roundInterval: 100    # optional; also compact every N assistant messages, one per LLM roundtrip (default 50)
 * ```
 *
 * @module dsh-dcp
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { splitConfig, resolveDcpConfig } from './config.js'
import { summarizeDeterministically, noticeText } from './summarizer.js'
import { registerDcpCommand } from './command.js'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json')

/**
 * Per-engine state uses module-scoped symbol keys, never `#private` members.
 * Cordis hands services to consuming fibers through derived receivers —
 * `ctx.mixin` binds methods to a withProps proxy and `createTraceable` calls
 * them on Object.create-derived shadows — so `/compact` and `/dcp compact`
 * (both `ctx.compaction.compactNow(...)`) routinely execute engine methods
 * with a `this` this class's constructor never initialized. Private members
 * brand-check against exactly that and throw
 * "Cannot read private member #triggerLabels from an object whose class did
 * not declare it", while symbol lookups traverse those receivers to this
 * instance's own state.
 *
 * Verified against dsh 0.1.2-alpha.3 (cordis 4.0.2): `withProps` /
 * `createTraceable` / `applyTraceable` receivers and the `ctx.mixin` service
 * forwarding are unchanged, and the base engine still brands no `#private`
 * state — the symbol-keyed approach remains both necessary and valid.
 */
const kRounds = Symbol('dsh-dcp.rounds')
const kTriggerLabels = Symbol('dsh-dcp.triggerLabels')
const kRoundInFlight = Symbol('dsh-dcp.roundInFlight')
const kSessionStats = Symbol('dsh-dcp.sessionStats')
const kRegisterRoundTrigger = Symbol('dsh-dcp.registerRoundTrigger')
const kMaybeRoundCompact = Symbol('dsh-dcp.maybeRoundCompact')
const kRecordStats = Symbol('dsh-dcp.recordStats')
const kRecordSessionStats = Symbol('dsh-dcp.recordSessionStats')
const kAppendNotice = Symbol('dsh-dcp.appendNotice')

/**
 * Deterministic compaction engine: `summarize()` overridden, everything else
 * inherited. Registers the `/dcp` command beside the inherited `/compact`.
 */
/** Element schema mirroring compaction-basic's model-policy override shape. */
const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
})

export class DcpEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'commands']

  static Config = z.object({
    // compaction-basic policy keys (forwarded verbatim)
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    // dsh-dcp knobs
    dedup: z.boolean(),
    purgeErrors: z.boolean(),
    maxItems: z.number().step(1).min(1),
    maxItemChars: z.number().step(1).min(1),
    maxSummaryTokens: z.number().step(1).min(1),
    language: z.string(),
    tokenEstimate: z.string(),
    protectedTools: z.array(z.string()),
    roundInterval: z.number().step(1).min(0),
    notice: z.boolean(),
  })

  /** Resolved dcp knobs; mutable at runtime through `/dcp set`. */
  dcp

  /** Compaction counters surfaced by `/dcp`. */
  /** @type {{compactions: number, shadowedTokens: number, lastAt: number|null}} */
  dcpStats

  /** Absolute module path, echoed by `/dcp set` for persistence snippets. */
  pluginPath

  constructor(ctx, config = {}) {
    const { basic, dcp } = splitConfig(config)
    super(ctx, basic)
    // Constructor assignments, not class fields: Node 26's V8 silently drops
    // every symbol-keyed class field after the first one in a derived class
    // (plain string-keyed and base-class fields are unaffected).
    /** Per-session assistant-message counters since the last dsh-dcp compaction. */
    this[kRounds] = new WeakMap()
    /** Sessions whose next `compactNow` is a round-interval trigger, not manual. */
    this[kTriggerLabels] = new WeakMap()
    /** Sessions with a round-triggered compaction still in flight. */
    this[kRoundInFlight] = new WeakSet()
    /** Per-session compaction records for `/dcp` (weak so disposed sessions drop out). */
    this[kSessionStats] = new WeakMap()
    this.dcp = { ...resolveDcpConfig(dcp) }
    this.dcpStats = { compactions: 0, shadowedTokens: 0, lastAt: null }
    this.pluginPath = fileURLToPath(import.meta.url)
    const engine = this
    ctx.effect(function* () {
      yield registerDcpCommand(ctx, engine, VERSION)
    }, 'dsh-dcp /dcp command lifecycle')
    if (this.config.auto) this[kRegisterRoundTrigger]()
  }

  /**
   * Round-interval trigger: count assistant messages (one per LLM roundtrip)
   * per session and, once the configured `roundInterval` is reached, compact
   * at the agent's next idle boundary through the manual-compaction seam
   * (`compactNow`). In-process subagents run through the same session/event
   * and agent/status dispatch, so continuable children are covered exactly
   * like the top-level session — and because one-shot subagents emit many
   * assistant messages inside a single turn, they now trigger too.
   */
  [kRegisterRoundTrigger]() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => {
      // Counting is skipped while disabled, but the listener stays registered
      // so `/dcp set roundInterval N` can arm it again at runtime.
      if (!this.dcp.roundInterval) return
      // Every assembled assistant message is one completed LLM roundtrip;
      // counting it (instead of completed turns) also covers one-shot
      // subagents, whose whole run is a single turn with many model calls.
      if (event.type !== 'assistant/message') return
      this[kRounds].set(session, (this[kRounds].get(session) ?? 0) + 1)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this[kMaybeRoundCompact](agent)
    })
  }

  /**
   * Attempt one round-triggered compaction for an idle agent. The attempt is
   * single-flight per session. `busy` (queued waking work won the race) and
   * `cancelled` (the agent was interrupted mid-compaction) both keep the
   * accumulated rounds for the next idle boundary — cancelling one attempt
   * must not cancel the N assistant messages behind it. Any other failure warns
   * and releases the boundary: the pressure trigger remains the safety net.
   */
  [kMaybeRoundCompact](agent) {
    const interval = this.dcp.roundInterval
    if (!interval) return
    const session = agent?.session
    if (session === undefined || this[kRoundInFlight].has(session)) return
    if ((this[kRounds].get(session) ?? 0) < interval) return
    this[kTriggerLabels].set(session, 'round')
    this[kRoundInFlight].add(session)
    const settle = () => this[kRoundInFlight].delete(session)
    const consume = () => {
      this[kRounds].delete(session)
      settle()
    }
    void this.compactNow(agent, new AbortController().signal).then(consume, (error) => {
      if (error instanceof ManualCompactionError && (error.code === 'busy' || error.code === 'cancelled')) {
        return settle()
      }
      this.ctx.logger.warn(`round-interval compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      consume()
    })
  }

  /**
   * The sole overridden seam: condense the replayed region deterministically.
   * No LLM call, no cancellation window beyond the fast synchronous walk.
   * Budgeting uses the CJK-aware estimator unless `tokenEstimate: ascii` is set.
   */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted()
    try {
      return summarizeDeterministically(input, this.dcp)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh-dcp deterministic summarization failed: ${message}`, { cause: error })
    }
  }

  /**
   * Automatic triggers (pressure, overflow): every committed region is
   * recorded through `compactRegion`, and ONE notice row is emitted per
   * trigger event — the parent's retry loop may commit several regions
   * before landing below the threshold, and stacking a near-duplicate row
   * per region is noise, while the stats below count each real compaction.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const label = trigger === 'context-overflow' ? 'overflow' : 'auto'
    const result = await super.compactIfNeeded(agent, trigger, signal)
    if (result !== null) this[kAppendNotice](agent.session, result, label)
    return result
  }

  /**
   * Manual seam (`/dcp compact`, `/compact`) and this plugin's own
   * round-interval trigger — the parent's `compactNow` bypasses
   * `compactRegion` (it drives `compactSurfaceRegion` directly), so without
   * this override the manual path would miss stats and the transcript notice.
   *
   * alpha.3 note: the base dereferences `signal` unguarded
   * (`signal.throwIfAborted()`), so the signal is required — both this
   * plugin's round trigger and the command invocation always pass one.
   */
  async compactNow(agent, signal, sourceCommandId) {
    const session = agent.session
    const trigger = this[kTriggerLabels].get(session) === 'round' ? 'round' : 'manual'
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId)
      // `null` means no useful range existed: release the round counter so an
      // early-session interval boundary cannot retry every idle boundary.
      // Manual compactions share the release: a user-driven compact restarts
      // interval counting whether or not it found anything to compact.
      if (result === null) this[kRounds].delete(session)
      else this.recordCompaction(session, result, trigger)
      return result
    } finally {
      this[kTriggerLabels].delete(session)
    }
  }

  /** Stats and round-counter restart for every committed region. */
  async compactRegion(start, end, agent, signal) {
    const result = await super.compactRegion(start, end, agent, signal)
    this[kRecordStats](agent.session, result)
    return result
  }

  /**
   * Record one committed compaction: bump the `/dcp` counters and restart the
   * round-interval counting.
   */
  [kRecordStats](session, result) {
    this.dcpStats.compactions += 1
    this.dcpStats.shadowedTokens += result.shadowedTokenCount
    this.dcpStats.lastAt = Date.now()
    this[kRounds].delete(session)
    this[kRecordSessionStats](session, result.shadowedTokenCount)
  }

  /**
   * Accumulate one committed compaction against its session. WeakMap keys
   * must be objects, so a session-less recording (should not happen) is
   * skipped rather than thrown on.
   */
  [kRecordSessionStats](session, shadowedTokenCount) {
    if (session === undefined || session === null || typeof session !== 'object') return
    const entry = this[kSessionStats].get(session) ?? { compactions: 0, shadowedTokens: 0 }
    entry.compactions += 1
    entry.shadowedTokens += shadowedTokenCount
    this[kSessionStats].set(session, entry)
  }

  /**
   * Append the one-line notice row for one committed compaction. The notice
   * is a `notice`-form plugin message, so every dsh frontend renders it as a
   * collapsed transcript row, live and on replay.
   */
  [kAppendNotice](session, result, trigger) {
    if (!this.dcp.notice) return
    const summary = boundContextSummary(noticeText(this.dcp.language, result.shadowedSeqs.length, result.shadowedTokenCount, trigger))
    try {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: summary }],
        source: { kind: 'plugin', plugin: 'dsh-dcp', form: 'notice', summary },
      }))
    } catch (error) {
      // The compaction already committed; a display-row failure must never
      // surface as a compaction failure.
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`dsh-dcp notice append failed: ${message}`)
    }
  }

  /**
   * Record stats and append the notice row for one `compactNow`-path
   * compaction.
   *
   * Internal seam: `compactNow` calls it after its durable commit; tests
   * drive it directly instead of mocking the upstream region machinery.
   * Public-named but not part of the dsh compaction contract.
   */
  recordCompaction(session, result, trigger) {
    this[kRecordStats](session, result)
    this[kAppendNotice](session, result, trigger)
  }

  /**
   * Per-session compaction overview for `/dcp`: one entry per live session
   * that has recorded at least one compaction. The WeakMap is not enumerable
   * and must never retain sessions, so this walks the sessions service and
   * looks each live session up. Disposed sessions (including one-shot
   * subagents) fall out of the store, and their records with them.
   *
   * @returns {Array<{id: string, compactions: number, shadowedTokens: number}>}
   */
  sessionStatsOverview() {
    const overview = []
    // Services live on ctx for a cordis plugin instance (`inject` only
    // declares them); this.sessions is undefined in production.
    for (const session of this.ctx.sessions?.list?.() ?? []) {
      const entry = this[kSessionStats].get(session)
      if (entry === undefined) continue
      overview.push({
        id: session.header?.id ?? '<unknown>',
        compactions: entry.compactions,
        shadowedTokens: entry.shadowedTokens,
      })
    }
    return overview
  }
}

export default DcpEngine
