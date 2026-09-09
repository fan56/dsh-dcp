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
 *     onModelSwitch: auto   # optional; after a model switch: notice (default) | auto-compact | off
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
import { summarizeDeterministically, noticeText, modelSwitchNoticeText } from './summarizer.js'
import { registerDcpCommand } from './command.js'
import { skillProvider } from './skill.js'

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
const kRoutes = Symbol('dsh-dcp.routes')
const kSwitchPending = Symbol('dsh-dcp.switchPending')
const kRegisterAssistantMessageCounter = Symbol('dsh-dcp.registerAssistantMessageCounter')
const kRegisterRoundTrigger = Symbol('dsh-dcp.registerRoundTrigger')
const kMaybeRoundCompact = Symbol('dsh-dcp.maybeRoundCompact')
const kRegisterModelSwitchWatch = Symbol('dsh-dcp.registerModelSwitchWatch')
const kMaybeOnModelSwitch = Symbol('dsh-dcp.maybeOnModelSwitch')
const kAttemptSwitchCompaction = Symbol('dsh-dcp.attemptSwitchCompaction')
const kRecordStats = Symbol('dsh-dcp.recordStats')
const kRecordSessionStats = Symbol('dsh-dcp.recordSessionStats')
const kAppendNotice = Symbol('dsh-dcp.appendNotice')
const kAppendSwitchNotice = Symbol('dsh-dcp.appendSwitchNotice')
const kMeetsMinTokens = Symbol('dsh-dcp.meetsMinTokens')

/**
 * A model switch detected fewer than this many assistant messages after the
 * session's last committed compaction is ignored (both notice and auto
 * modes): a switch right after a compaction has no stale history to shadow,
 * so prompting (or compacting again) would only add noise and rewrites.
 * Deliberately not a config key — it is a guard rail, not a user-intent knob.
 * The token-size counterpart is the user-tunable `modelSwitchMinTokens`.
 */
const MODEL_SWITCH_MIN_ROUNDS = 10

/**
 * Deterministic compaction engine: `summarize()` overridden, everything else
 * inherited. Registers the `/dcp` command beside the inherited `/compact`,
 * and serves the bundled usage/config guide through the host skill registry.
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
  static inject = ['llm', 'tokenMeter', 'sessions', 'commands', 'skills']

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
    onModelSwitch: z.string(),
    modelSwitchMinTokens: z.number().step(1).min(0),
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
    /** Per-session last routed `{provider, model}` for model-switch detection. */
    this[kRoutes] = new WeakMap()
    /** Sessions with a model-switch auto compaction waiting for an idle boundary. */
    this[kSwitchPending] = new WeakSet()
    this.dcp = { ...resolveDcpConfig(dcp) }
    this.dcpStats = { compactions: 0, shadowedTokens: 0, lastAt: null }
    this.pluginPath = fileURLToPath(import.meta.url)
    const engine = this
    // Bundled usage/config guide. Soft-guarded: engines constructed in exotic
    // hosts without the skill registry must still boot; losing the bundled
    // guide is non-fatal. On the real host, `skills` in `static inject`
    // guarantees the service is present (verified by scripts/smoke-boot.mjs).
    try {
      ctx?.skills?.registerProvider?.(() => skillProvider)
    } catch {
      // non-fatal — see comment above
    }
    ctx.effect(function* () {
      yield registerDcpCommand(ctx, engine, VERSION)
    }, 'dsh-dcp /dcp command lifecycle')
    // The counter is unconditional: the round trigger reads it, and so does
    // the model-switch recency gate. Counting also continues while the round
    // trigger is disabled (`roundInterval: 0`), so `/dcp set roundInterval N`
    // can arm it mid-session and the switch gate stays meaningful.
    this[kRegisterAssistantMessageCounter]()
    if (this.config.auto) this[kRegisterRoundTrigger]()
    this[kRegisterModelSwitchWatch]()
  }

  /**
   * Unconditional per-session assistant-message counting: every assembled
   * assistant message is one completed LLM roundtrip, so this WeakMap is the
   * "rounds since the session's last committed compaction" clock shared by
   * the round trigger and the model-switch recency gate.
   */
  [kRegisterAssistantMessageCounter]() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      this[kRounds].set(session, (this[kRounds].get(session) ?? 0) + 1)
    })
  }

  /**
   * Round-interval trigger: once the session's assistant-message clock
   * (kept by `[kRegisterAssistantMessageCounter]`) reaches the configured
   * `roundInterval`, compact at the agent's next idle boundary through the
   * manual-compaction seam (`compactNow`). In-process subagents run through
   * the same session/event and agent/status dispatch, so continuable
   * children are covered exactly like the top-level session — and because
   * one-shot subagents emit many assistant messages inside a single turn,
   * they now trigger too.
   */
  [kRegisterRoundTrigger]() {
    const { ctx } = this
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
   * Model-switch watch: fold `request/context` (the per-request routing
   * snapshot, logged on change) per session; a provider or model change from
   * the session's previous route is a switch. Covers every entry point — TUI
   * `/model`, web clients, changed default settings — because it observes the
   * effective route rather than any client's selection intent. Subagent
   * sessions fold independently, mirroring the round trigger's stance.
   */
  [kRegisterModelSwitchWatch]() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'request/context') return
      const data = /** @type {{data?: {provider?: unknown, model?: unknown}}} */ (event).data
      if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') return
      const route = { provider: data.provider, model: data.model }
      const previous = this[kRoutes].get(session)
      this[kRoutes].set(session, route)
      // First observed request only seeds the baseline: without a previous
      // route there is no "switched from" to report.
      if (previous === undefined) return
      if (previous.provider === route.provider && previous.model === route.model) return
      this[kMaybeOnModelSwitch](session, previous, route)
    })
    // The auto mode's compaction needs a real agent (`runMaintenance`, routed
    // options), which `session/event` never carries — so pending switches
    // wait for the same idle boundary the round trigger uses.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this[kAttemptSwitchCompaction](agent)
    })
  }

  /**
   * Handle one detected model switch. Two gates guard every mode: the
   * recency gate (fewer than `MODEL_SWITCH_MIN_ROUNDS` assistant messages
   * since the session's last committed compaction — nothing stale has
   * accumulated, so prompting or compacting again only adds noise and
   * rewrites) and the size gate (`modelSwitchMinTokens` — the context is
   * too small for shadowing to be worth anything). `notice` appends the
   * suggest-`/dcp compact` row; `auto` appends the in-progress row and
   * marks the session for the next idle boundary. The `auto` mode is an
   * automatic compaction trigger, so the `auto: false` master switch
   * downgrades it to `notice`.
   */
  [kMaybeOnModelSwitch](session, previous, route) {
    let mode = this.dcp.onModelSwitch
    if (mode === 'off') return
    if (mode === 'auto' && !this.config.auto) mode = 'notice'
    if ((this[kRounds].get(session) ?? 0) < MODEL_SWITCH_MIN_ROUNDS) return
    if (!this[kMeetsMinTokens](session)) return
    const from = `${previous.provider}/${previous.model}`
    const to = `${route.provider}/${route.model}`
    if (mode === 'notice') {
      this[kAppendSwitchNotice](session, 'notice', from, to)
      return
    }
    this[kSwitchPending].add(session)
    this[kAppendSwitchNotice](session, 'auto', from, to)
  }

  /**
   * Size gate for the model-switch feature: the session's current priced
   * surface must reach `modelSwitchMinTokens` before a switch is worth
   * announcing — below it there is not enough history for shadowing to save
   * anything meaningful. `0` disables the gate. Measured per switch (the
   * `request/context` event only fires on route changes, so this is rare).
   * Measurement failure or absence fails open: the recency gate still
   * applies, and a meterless exotic host keeps the feature alive.
   */
  [kMeetsMinTokens](session) {
    const min = this.dcp.modelSwitchMinTokens
    if (!min) return true
    try {
      // tokenMeter arrives through `static inject`, which checkJs cannot see
      // on the Context type — the optional chain plus cast is the contract.
      const meter = /** @type {{measure?: (s: unknown) => {surfaceTokens?: number} | null}} */ (/** @type {any} */ (this.ctx).tokenMeter)
      const measurement = meter?.measure?.(session)
      if (typeof measurement?.surfaceTokens !== 'number') return true
      return measurement.surfaceTokens >= min
    } catch {
      return true
    }
  }

  /**
   * Serve one pending model-switch compaction at an idle boundary. The
   * attempt shares the round trigger's single-flight WeakSet, so the two
   * idle listeners can never drive concurrent `compactNow` calls on the
   * same agent; the trigger label is claimed here (not at detection time)
   * so a manual `/dcp compact` in between cannot steal it. `busy` and
   * `cancelled` restore the pending mark for the next boundary, mirroring
   * the round trigger; any other failure warns and drops it — the pressure
   * trigger remains the safety net.
   */
  [kAttemptSwitchCompaction](agent) {
    const session = agent?.session
    if (session === undefined || !this[kSwitchPending].has(session)) return
    if (this[kRoundInFlight].has(session)) return
    this[kSwitchPending].delete(session)
    this[kTriggerLabels].set(session, 'model-switch')
    this[kRoundInFlight].add(session)
    const settle = () => this[kRoundInFlight].delete(session)
    void this.compactNow(agent, new AbortController().signal).then(settle, (error) => {
      settle()
      if (error instanceof ManualCompactionError && (error.code === 'busy' || error.code === 'cancelled')) {
        this[kSwitchPending].add(session)
        return
      }
      this.ctx.logger.warn(`model-switch compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Append the model-switch notice row (same collapsed-row channel as the
   * compaction notice). Failures never surface as switch-handling failures —
   * in auto mode the compaction still proceeds, in notice mode the switch is
   * simply unannounced.
   */
  [kAppendSwitchNotice](session, mode, from, to) {
    const summary = boundContextSummary(modelSwitchNoticeText(this.dcp.language, mode, from, to))
    try {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: summary }],
        source: { kind: 'plugin', plugin: 'dsh-dcp', form: 'notice', summary },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`dsh-dcp model-switch notice append failed: ${message}`)
    }
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
   * Manual seam (`/dcp compact`, `/compact`) and this plugin's own automatic
   * idle-boundary triggers (round interval, model switch) — the parent's
   * `compactNow` bypasses `compactRegion` (it drives `compactSurfaceRegion`
   * directly), so without this override those paths would miss stats and the
   * transcript notice.
   *
   * alpha.3 note: the base dereferences `signal` unguarded
   * (`signal.throwIfAborted()`), so the signal is required — both this
   * plugin's triggers and the command invocation always pass one.
   */
  async compactNow(agent, signal, sourceCommandId) {
    const session = agent.session
    const trigger = this[kTriggerLabels].get(session) ?? 'manual'
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
   * Record one committed compaction: bump the `/dcp` counters and restart
   * the round-interval counting. A committed compaction also clears any
   * pending model-switch compaction — the stale history the switch was
   * going to shadow is now shadowed by this compaction, whatever triggered
   * it.
   */
  [kRecordStats](session, result) {
    this.dcpStats.compactions += 1
    this.dcpStats.shadowedTokens += result.shadowedTokenCount
    this.dcpStats.lastAt = Date.now()
    this[kRounds].delete(session)
    this[kSwitchPending].delete(session)
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
