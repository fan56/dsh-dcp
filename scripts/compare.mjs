#!/usr/bin/env node
/**
 * Simulate compaction + provider prefix-cache mechanics against a real dsh
 * session log, comparing the dcp backend with the no-compaction baseline.
 *
 * What it measures (static, deterministic — no LLM calls):
 *   - per-request input tokens under two pricings: host flat 4 chars/token
 *     and dcp's CJK-aware estimate
 *   - provider prefix-cache hit/miss: a request is billed as a cache hit for
 *     the longest token-prefix it shares with the previous request. Pure
 *     append → the previous request is a prefix of the next (≈full hit). A
 *     head-anchored compaction swaps the leading span for a checkpoint, so
 *     the next request starts cold (≈0 hit) — for EVERY backend, including
 *     compaction-basic; the checkpoint text is brand new.
 *   - when the dcp engine would compact (host tokens ≥ threshold × window)
 *     and what its deterministic summary costs vs the region it shadows.
 *
 * Usage:
 *   node scripts/compare.mjs <session.jsonl.zstd|session.jsonl> [contextWindow] [thresholdRatio] [retainRatio] [language]
 *
 * Environment: DCP_* mirrors the plugin config knobs (dedup, purgeErrors,
 * maxItems, maxItemChars, maxSummaryTokens, protectedTools).
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { summarizeDeterministically, estimateMessageTokens } from '../lib/summarizer.js'

const [, , sessionArg, windowArg, thresholdArg, retainArg, languageArg] = process.argv
const CONTEXT_WINDOW = Number(windowArg ?? 128000)
const THRESHOLD = Number(thresholdArg ?? 0.8)
const RETAIN = Number(retainArg ?? 0.16)
const LANGUAGE = languageArg ?? 'zh'

const DCP = {
  dedup: process.env.DCP_DEDUP !== 'false',
  purgeErrors: process.env.DCP_PURGE_ERRORS !== 'false',
  maxItems: Number(process.env.DCP_MAX_ITEMS ?? 10),
  maxItemChars: Number(process.env.DCP_MAX_ITEM_CHARS ?? 200),
  maxSummaryTokens: Number(process.env.DCP_MAX_SUMMARY_TOKENS ?? 2048),
  language: LANGUAGE,
  tokenEstimate: 'cjk',
  protectedTools: ['write', 'edit', 'apply_patch'],
}

const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

function loadSession(path) {
  const source = path.endsWith('.zstd')
    ? execFileSync('zstd', ['-d', '-f', '-c', path], { maxBuffer: 256 * 1024 * 1024 }).toString()
    : fs.readFileSync(path, 'utf8')
  return source.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Rebuild the message surface (append + replace ops), returning ordered nodes. */
function rebuildSurface(events) {
  const surface = []
  for (const event of events) {
    let message
    if (event.type === 'user/message') message = event.data
    else if (event.type === 'assistant/message') message = event.data.message
    else if (event.type === 'tool/result') message = event.data.message
    else continue
    const node = { seq: event.seq, type: event.type, message }
    const op = event.surfaceOp
    if (op && op.op === 'replace') {
      const start = surface.findIndex((n) => n.seq === op.start)
      const end = surface.findIndex((n) => n.seq === op.end)
      if (start !== -1 && end !== -1) surface.splice(start, end - start + 1, node)
    } else {
      surface.push(node)
    }
  }
  return surface
}

/** Host token meter: flat 4 chars/token, mirroring dsh-token-meter minus per-block overhead. */
function hostTokens(content) {
  return content.reduce((total, block) => {
    if (block.type === 'text') return total + Math.ceil(block.text.length / 4)
    if (block.type === 'tool-call') return total + Math.ceil(block.arguments.length / 4)
    if (block.type === 'tool-result') {
      return total + block.content.reduce((sum, inner) => sum + (inner.type === 'text' ? Math.ceil(inner.text.length / 4) : 0), 0)
    }
    return total
  }, 0)
}

function nodeTokens(node, mode) {
  return mode === 'cjk' ? estimateMessageTokens(node.message, 'cjk') : hostTokens(node.message.content)
}

function surfaceTokens(surface, mode) {
  return surface.reduce((sum, node) => sum + nodeTokens(node, mode), 0)
}

/**
 * Balance (open tool calls) before every cut, mirroring the official
 * tool-pairing eventDelta: only `assistant/message` tool-call blocks open a
 * call, only `tool/result` events close one; every other surface event
 * (user messages, subagent-settled aggregates) is neutral — subagent tool
 * calls live in the child session and never unbalance the parent surface.
 */
function prefixBalances(nodes) {
  const balance = [0]
  let open = 0
  for (const node of nodes) {
    if (node.type === 'assistant/message') {
      open += node.message.content.reduce((delta, block) => delta + (block.type === 'tool-call' ? 1 : 0), 0)
    } else if (node.type === 'tool/result') {
      open -= 1
    }
    balance.push(open)
  }
  return balance
}

/**
 * Head-anchored region selection mirroring compaction-basic's
 * `selectCompactableRange`: retain a priced tail, then back up to a
 * tool-pairing-balanced cut. Returns the region nodes or null.
 */
function selectRegion(nodes, retainTokens, mode) {
  if (nodes.length === 0) return null
  const balance = prefixBalances(nodes)
  const tokens = nodes.map((node) => nodeTokens(node, mode))
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += tokens[index]
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  if (keepFrom === 0) return null
  while (keepFrom > 0 && balance[keepFrom] !== 0) keepFrom -= 1
  if (keepFrom === 0) return null
  return nodes.slice(0, keepFrom)
}

function checkpointMessage(summaryText, compactionId) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
      { type: 'text', text: summaryText },
      { type: 'text', text: '</compacted-summary>' },
    ],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  }
}

/**
 * Longest common token-prefix of two surfaces, node by node (conservative:
 * a partially-shared node counts as zero).
 */
function commonPrefixTokens(prev, curr, mode) {
  let tokens = 0
  const length = Math.min(prev.length, curr.length)
  for (let index = 0; index < length; index += 1) {
    if (!isDeepStrictEqual(prev[index].message, curr[index].message)) break
    tokens += nodeTokens(curr[index], mode)
  }
  return tokens
}

function fmt(n) {
  return n.toLocaleString('en-US')
}

/**
 * Replay the session in event order, maintaining a persistent surface. At
 * each step boundary the engine may compact (dcp scenario), then the request
 * is priced and its prefix-cache hit measured against the previous request's
 * surface.
 */
function simulate(events, mode, useDcp) {
  const surface = []
  const stats = /** @type {{ requests: number, inputTokens: number, hitTokens: number, compactions: Array<{regionNodes: number, regionHost: number, regionCjk: number, summaryHost: number, summaryCjk: number, compression: string, totalAfter: number, preview: string}> }} */ ({ requests: 0, inputTokens: 0, hitTokens: 0, compactions: [] })
  let prevSurface = []
  let compactionId = 0

  for (const event of events) {
    let message
    if (event.type === 'user/message') message = event.data
    else if (event.type === 'assistant/message') message = event.data.message
    else if (event.type === 'tool/result') message = event.data.message
    else if (event.type === 'step/start') {
      if (useDcp) {
        let safety = 0
        while (surfaceTokens(surface, 'host') >= CONTEXT_WINDOW * THRESHOLD && safety < 8) {
          const region = selectRegion(surface, Math.floor(CONTEXT_WINDOW * RETAIN), 'host')
          if (region === null) break
          const regionHost = region.reduce((sum, node) => sum + hostTokens(node.message.content), 0)
          const regionCjk = region.reduce((sum, node) => sum + estimateMessageTokens(node.message, 'cjk'), 0)
          const result = summarizeDeterministically({ messages: region.map((node) => node.message) }, DCP)
          const framed = checkpointMessage(result.summary[0].text, `sim-${compactionId + 1}`)
          const summaryHost = hostTokens(framed.content)
          const summaryCjk = estimateMessageTokens(framed, 'cjk')
          const checkpointNode = { seq: `checkpoint-${compactionId + 1}`, type: 'user/message', message: framed }

          surface.splice(0, region.length, checkpointNode)
          const totalAfter = surfaceTokens(surface, mode)
          stats.compactions.push({
            regionNodes: region.length,
            regionHost,
            regionCjk,
            summaryHost,
            summaryCjk,
            compression: (regionHost / Math.max(1, summaryHost)).toFixed(1),
            totalAfter,
            preview: result.summary[0].text.split('\n').slice(0, 8).join(' | '),
          })
          compactionId += 1
          safety += 1
        }
      }
      const total = surfaceTokens(surface, mode)
      const hit = commonPrefixTokens(prevSurface, surface, mode)
      stats.requests += 1
      stats.inputTokens += total
      stats.hitTokens += hit
      prevSurface = surface.map((node) => node)
      continue
    } else {
      continue
    }
    const node = { seq: event.seq, type: event.type, message }
    const op = event.surfaceOp
    if (op && op.op === 'replace') {
      const start = surface.findIndex((n) => n.seq === op.start)
      const end = surface.findIndex((n) => n.seq === op.end)
      if (start !== -1 && end !== -1) surface.splice(start, end - start + 1, node)
    } else {
      surface.push(node)
    }
  }
  return stats
}

// -- main ------------------------------------------------------------------

const events = loadSession(sessionArg)
const surface = rebuildSurface(events)
const totalHost = surfaceTokens(surface, 'host')
const totalCjk = surfaceTokens(surface, 'cjk')

console.log('='.repeat(72))
console.log('dsh-dcp cache simulation on a real session')
console.log('='.repeat(72))
console.log(`session : ${sessionArg}`)
console.log(`window  : ${fmt(CONTEXT_WINDOW)} · threshold ${THRESHOLD} (trigger at ${fmt(CONTEXT_WINDOW * THRESHOLD)} host tokens) · retain ${RETAIN} · language ${LANGUAGE}`)
console.log(`surface : ${surface.length} message nodes`)
console.log(`tokens  : host ${fmt(totalHost)} · cjk ${fmt(totalCjk)} (ratio ${(totalCjk / totalHost).toFixed(3)})`)
console.log('')

for (const mode of ['host', 'cjk']) {
  const baseline = simulate(events, mode, false)
  const dcp = simulate(events, mode, true)
  const hitRate = (stats) => (stats.inputTokens > 0 ? stats.hitTokens / stats.inputTokens : 0)
  console.log(`── pricing: ${mode === 'host' ? 'host flat 4 chars/token' : 'dcp CJK-aware'} ──`)
  console.log(`  baseline (no compaction)`)
  console.log(`    ${baseline.requests} requests · input ${fmt(baseline.inputTokens)} tok · cache hit ${(hitRate(baseline) * 100).toFixed(1)}% · miss ${fmt(Math.round(baseline.inputTokens - baseline.hitTokens))} tok`)
  console.log(`  dcp backend`)
  console.log(`    ${dcp.compactions.length} compaction(s) · ${dcp.requests} requests · input ${fmt(dcp.inputTokens)} tok · cache hit ${(hitRate(dcp) * 100).toFixed(1)}% · miss ${fmt(Math.round(dcp.inputTokens - dcp.hitTokens))} tok`)
  dcp.compactions.forEach((c, index) => {
    console.log(`    #${index + 1}: region ${fmt(c.regionHost)} tok (${c.regionNodes} nodes) → summary ${fmt(c.summaryHost)} tok · ${c.compression}x smaller · next request ${fmt(c.totalAfter)} tok (starts cold for every backend)`)
  })
  if (dcp.compactions.length > 0) {
    const callInput = dcp.compactions.reduce((sum, c) => sum + c.regionHost, 0)
    console.log(`    LLM summarization calls: dcp 0 · compaction-basic ${dcp.compactions.length} (≈${fmt(Math.round(callInput))} input tokens replayed across them)`)
  }
  console.log('')
}

const last = simulate(events, 'cjk', true)
if (last.compactions.length > 0) {
  const c = last.compactions[last.compactions.length - 1]
  console.log('─ sample deterministic checkpoint (last compaction) ─')
  console.log(c.preview)
  console.log('')
  console.log('Note: the request right after a compaction starts cold (hit ≈ 0)')
  console.log('for ANY backend — compaction-basic included — because the leading')
  console.log('span is replaced by brand-new checkpoint text. dcp only differs in')
  console.log('summary size (here above) and in paying zero LLM calls per compaction.')
}
