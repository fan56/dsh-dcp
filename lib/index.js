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
 * ```
 *
 * @module dsh-dcp
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { splitConfig, resolveDcpConfig } from './config.js'
import { summarizeDeterministically } from './summarizer.js'
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
  })

  /** Resolved dcp knobs; mutable at runtime through `/dcp set`. */
  dcp

  /** Compaction counters surfaced by `/dcp`. */
  dcpStats

  /** Absolute module path, echoed by `/dcp set` for persistence snippets. */
  pluginPath

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

  /** Count every committed compaction (automatic and manual) for `/dcp`. */
  async compactRegion(start, end, agent, signal) {
    const result = await super.compactRegion(start, end, agent, signal)
    this.dcpStats.compactions += 1
    this.dcpStats.shadowedTokens += result.shadowedTokenCount
    this.dcpStats.lastAt = Date.now()
    return result
  }
}

export default DcpEngine
