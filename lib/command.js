/**
 * The `/dcp` slash command: status, manual compaction, and runtime knobs —
 * one entry point, no required arguments (design references opencode-dcp's
 * `/dcp` panel in a dsh-idiomatic, text-only form).
 *
 * @module dsh-dcp/command
 */

import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { RUNTIME_SETTABLE } from './config.js'

const USAGE = `Usage:
  /dcp                show status (mode, config, compaction stats)
  /dcp compact        compact now (deterministic, no LLM call)
  /dcp set <k> <v>    adjust a knob for this session (dedup, purgeErrors,
                      maxItems, maxItemChars, maxSummaryTokens, language,
                      thresholdRatio)`

const FAILURE_TEXT = Object.freeze({
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged.',
  summary: 'Compaction could not produce a useful summary. The conversation is unchanged.',
  commit: 'Compaction did not finish cleanly; inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
})

function success(text, sourceEventSeq) {
  return sourceEventSeq === undefined ? { kind: 'success', text } : { kind: 'success', text, sourceEventSeq }
}

function failure(text) {
  return { kind: 'error', text }
}

/** One `key=value` runtime assignment, or a diagnostic string. */
function applySet(engine, key, rawValue) {
  const kind = RUNTIME_SETTABLE[key]
  if (kind === undefined) return `unknown key "${key}" — settable: ${Object.keys(RUNTIME_SETTABLE).join(', ')}`
  const value = rawValue.toLowerCase()
  if (kind === 'boolean') {
    if (!['on', 'off', 'true', 'false'].includes(value)) return `${key} expects on/off/true/false`
    engine.dcp[key] = value === 'on' || value === 'true'
    return `${key} = ${engine.dcp[key]} (this session)`
  }
  if (kind === 'language') {
    if (value !== 'en' && value !== 'zh') return 'language expects en or zh'
    engine.dcp.language = value
    return `language = ${value} (this session)`
  }
  const numeric = Number(rawValue)
  if (!Number.isFinite(numeric)) return `${key} expects a number`
  if (kind === 'ratio') {
    if (numeric <= 0 || numeric > 1) return 'thresholdRatio expects a number in (0, 1]'
    if (engine.config.retainRatio !== undefined && engine.config.retainRatio >= numeric) {
      return `thresholdRatio must stay above retainRatio (${engine.config.retainRatio})`
    }
    engine.config = Object.freeze({ ...engine.config, thresholdRatio: numeric })
    return `thresholdRatio = ${numeric} (this session)`
  }
  if (!Number.isInteger(numeric) || numeric < 1) return `${key} expects a positive integer`
  engine.dcp[key] = numeric
  return `${key} = ${numeric} (this session)`
}

/** Human-readable engine status block. */
function statusText(engine, version) {
  const stats = engine.dcpStats
  const lines = [
    `dsh-dcp ${version} — deterministic compaction backend (zero LLM summarization calls)`,
    `config: dedup=${engine.dcp.dedup} purgeErrors=${engine.dcp.purgeErrors} maxItems=${engine.dcp.maxItems} maxItemChars=${engine.dcp.maxItemChars} maxSummaryTokens=${engine.dcp.maxSummaryTokens} language=${engine.dcp.language} thresholdRatio=${engine.config.thresholdRatio}`,
    `stats: ${stats.compactions} compaction${stats.compactions === 1 ? '' : 's'}, ~${stats.shadowedTokens} tokens shadowed, ${stats.compactions} LLM summary call${stats.compactions === 1 ? '' : 's'} avoided`,
  ]
  if (stats.lastAt !== null) lines.push(`last compaction: ${new Date(stats.lastAt).toLocaleString()}`)
  return lines.join('\n')
}

/** `/dcp compact` — manual deterministic compaction through the seam. */
async function compactNow(ctx, invocation, engine) {
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return success('No compactable history yet.')
    return success(
      `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) deterministically — no LLM call used.`,
      result.summarySeq,
    )
  } catch (error) {
    if (invocation.signal.aborted) return failure(FAILURE_TEXT.cancelled)
    if (error instanceof ManualCompactionError) return failure(FAILURE_TEXT[error.code] ?? error.message)
    throw error
  }
}

/** Dispatch one `/dcp` invocation. */
export async function executeDcp(ctx, invocation, engine, version) {
  const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
  const [subcommand, ...rest] = tokens
  if (subcommand === undefined) return success(statusText(engine, version))
  if (subcommand === 'status') return success(statusText(engine, version))
  if (subcommand === 'help') return success(USAGE)
  if (subcommand === 'compact') return compactNow(ctx, invocation, engine)
  if (subcommand === 'set') {
    if (rest.length < 2) return failure(USAGE)
    const outcome = applySet(engine, rest[0], rest.slice(1).join(' '))
    if (!/^[\w.]+ = /.test(outcome)) return failure(outcome)
    return success(
      `${outcome}\npersist across restarts in ~/.dsh/cordis.patch.yml:\n  - id: compaction-basic\n    name: ${engine.pluginPath ?? '<abs path to dsh-dcp>/lib/index.js'}\n    config:\n      ${rest[0]}: ${rest.slice(1).join(' ')}`,
    )
  }
  return failure(`unknown subcommand "${subcommand}"\n${USAGE}`)
}

/**
 * Register `/dcp` on the host command registry.
 * @returns {() => void} disposer for cordis effect teardown.
 */
export function registerDcpCommand(ctx, engine, version) {
  return ctx.commands.register({
    name: 'dcp',
    description: 'dsh-dcp: deterministic compaction status and controls',
    handler: (invocation) => executeDcp(ctx, invocation, engine, version),
  })
}
