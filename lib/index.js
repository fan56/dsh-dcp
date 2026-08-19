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
 *     thresholdRatio: 0.7   # optional; every key is optional
 *     roundInterval: 100    # optional; also compact every N completed turns (default 50)
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
  dcpStats

  /** Absolute module path, echoed by `/dcp set` for persistence snippets. */
  pluginPath

  /**
   * Completed-turn counters since the last dsh-dcp compaction, per session —
   * one "round" is one `turn/end` whose reason is `completed`. Weak keys:
   * disposed sessions (including one-shot subagents) drop out with the object.
   */
  #rounds = new WeakMap()

  /**
   * Sessions whose next `compactNow` is a round-interval trigger rather than
   * a manual command. Only {@link DcpEngine.#maybeRoundCompact} writes;
   * `compactNow` reads and clears its own entry, so a stale marker can only
   * turn a manual compaction into a labeled `'round'` one — never the reverse.
   */
  #triggerLabels = new WeakMap()

  /** Sessions with a round-triggered compaction still in flight. */
  #roundInFlight = new WeakSet()

  constructor(ctx, config = {}) {
    const { basic, dcp } = splitConfig(config)
    super(ctx, basic)
    this.dcp = { ...resolveDcpConfig(dcp) }
    this.dcpStats = { compactions: 0, shadowedTokens: 0, lastAt: null }
    this.pluginPath = fileURLToPath(import.meta.url)
    const engine = this
    ctx.effect(function* () {
      yield registerDcpCommand(ctx, engine, VERSION)
    }, 'dsh-dcp /dcp command lifecycle')
    if (this.config.auto) this.#registerRoundTrigger()
  }

  /**
   * Round-interval trigger: count completed turns per session and, once the
   * configured `roundInterval` is reached, compact at the agent's next idle
   * boundary through the manual-compaction seam (`compactNow`). In-process
   * subagents run through the same session/event and agent/status dispatch,
   * so continuable children are covered exactly like the top-level session.
   */
  #registerRoundTrigger() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => {
      // Counting is skipped while disabled, but the listener stays registered
      // so `/dcp set roundInterval N` can arm it again at runtime.
      if (!this.dcp.roundInterval) return
      if (event.type !== 'turn/end' || event.data.reason?.kind !== 'completed') return
      this.#rounds.set(session, (this.#rounds.get(session) ?? 0) + 1)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.#maybeRoundCompact(agent)
    })
  }

  /**
   * Attempt one round-triggered compaction for an idle agent. The attempt is
   * single-flight per session. `busy` (queued waking work won the race) and
   * `cancelled` (the agent was interrupted mid-compaction) both keep the
   * accumulated rounds for the next idle boundary — cancelling one attempt
   * must not cancel the N completed turns behind it. Any other failure warns
   * and releases the boundary: the pressure trigger remains the safety net.
   */
  #maybeRoundCompact(agent) {
    const interval = this.dcp.roundInterval
    if (!interval) return
    const session = agent?.session
    if (session === undefined || this.#roundInFlight.has(session)) return
    if ((this.#rounds.get(session) ?? 0) < interval) return
    this.#triggerLabels.set(session, 'round')
    this.#roundInFlight.add(session)
    const settle = () => this.#roundInFlight.delete(session)
    const consume = () => {
      this.#rounds.delete(session)
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
    if (result !== null) this.#appendNotice(agent.session, result, label)
    return result
  }

  /**
   * Manual seam (`/dcp compact`, `/compact`) and this plugin's own
   * round-interval trigger — the parent's `compactNow` bypasses
   * `compactRegion` (it drives `compactSurfaceRegion` directly), so without
   * this override the manual path would miss stats and the transcript notice.
   */
  async compactNow(agent, signal, sourceCommandId) {
    const session = agent.session
    const trigger = this.#triggerLabels.get(session) === 'round' ? 'round' : 'manual'
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId)
      // `null` means no useful range existed: release the round counter so an
      // early-session interval boundary cannot retry every idle boundary.
      // Manual compactions share the release: a user-driven compact restarts
      // interval counting whether or not it found anything to compact.
      if (result === null) this.#rounds.delete(session)
      else this.recordCompaction(session, result, trigger)
      return result
    } finally {
      this.#triggerLabels.delete(session)
    }
  }

  /** Stats and round-counter restart for every committed region. */
  async compactRegion(start, end, agent, signal) {
    const result = await super.compactRegion(start, end, agent, signal)
    this.#recordStats(agent.session, result)
    return result
  }

  /**
   * Record one committed compaction: bump the `/dcp` counters and restart the
   * round-interval counting.
   */
  #recordStats(session, result) {
    this.dcpStats.compactions += 1
    this.dcpStats.shadowedTokens += result.shadowedTokenCount
    this.dcpStats.lastAt = Date.now()
    this.#rounds.delete(session)
  }

  /**
   * Append the one-line notice row for one committed compaction. The notice
   * is a `notice`-form plugin message, so every dsh frontend renders it as a
   * collapsed transcript row, live and on replay.
   */
  #appendNotice(session, result, trigger) {
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
   */
  recordCompaction(session, result, trigger) {
    this.#recordStats(session, result)
    this.#appendNotice(session, result, trigger)
  }
}

export default DcpEngine
