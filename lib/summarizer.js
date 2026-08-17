/**
 * Deterministic region summarizer — the dsh-dcp core.
 *
 * Where compaction-basic replays the region into an LLM summarization call,
 * this module condenses the same replayed messages with pure code: verbatim
 * user intents, touched files, executed commands, one-line errors, pending
 * todos, duplicate tool calls, and the durable facts of a prior checkpoint.
 * Zero LLM calls, stable output for identical input (design references
 * Opencode-DCP/opencode-dynamic-context-pruning: dedup, error purge,
 * "technical summary instead of prose").
 *
 * The output keeps compaction-basic's checkpoint section names so downstream
 * consumers (and a later basic-engine compaction merging prior
 * `<compacted-summary>` blocks) see a familiar structure.
 *
 * @module dsh-dcp/summarizer
 */

/** Section headers shared with compaction-basic's checkpoint instruction. */
export const SECTIONS = Object.freeze({
  intent: 'Primary Request and Intent',
  concepts: 'Key Technical Concepts',
  files: 'Files and Code',
  errors: 'Errors and Fixes',
  todos: 'Pending Jobs',
  current: 'Current Work',
  next: 'Next Step',
  context: 'Critical Context',
})

/** Prior-checkpoint sections worth carrying forward (stale ones regenerate). */
const CARRIED_SECTIONS = new Set([
  SECTIONS.intent,
  SECTIONS.concepts,
  SECTIONS.files,
  SECTIONS.errors,
  SECTIONS.context,
])

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Arg keys whose string value names a filesystem path. */
const PATH_KEYS = ['file_path', 'absolute_path', 'notebook_path', 'path', 'glob', 'pattern']
/** Arg keys whose string value is a shell command. */
const COMMAND_KEYS = ['command', 'cmd', 'script']
/** Tool-name fragments that mark a mutating (write-side) call. */
const WRITE_TOOL = /write|edit|patch|delete|remove|mkdir|move|rename|create/i
/** Command vocabulary lifted into Key Technical Concepts. */
const COMMAND_CONCEPTS = /\b(git|npm|pnpm|yarn|bun|cargo|go|python|pip|uv|docker|kubectl|helm|make|gradle|maven|curl|terraform)\b/gi
/** Checkbox todo lines in any user/assistant text. */
const TODO_LINE = /^\s*[-*]\s+\[( |x|X)\]\s*(.+)$/gm
/** English todo markers, colon-terminated to avoid prose hits. */
const MARKER_TODO_EN = /^\s*(?:TODO|FIXME)\s*[:：]\s*(.+)$/gim
/** Chinese todo marker, colon-terminated. */
const MARKER_TODO_ZH = /^\s*待办\s*[:：]\s*(.+)$/gim
/** First-line signals of a tool error, English set (terminal locale LANG=C). */
const ERROR_LINE_EN = /(error|failed|failure|fatal|exception|enoent|eacces|eperm|denied|refused|not found|cannot |unable |exit code [1-9])/i
/** First-line signals of a tool error, Chinese set — dsh-bash and friends can surface localized failures. */
const ERROR_LINE_ZH = /(失败|错误|报错|异常|找不到|未找到|不存在|无法|拒绝|超时|崩溃|致命)/i

/** Error regexes active for one output language. */
function errorPatterns(language) {
  return language === 'zh' ? [ERROR_LINE_EN, ERROR_LINE_ZH] : [ERROR_LINE_EN]
}

/** Todo-line regexes active for one output language, split by shape. */
function todoPatterns(language) {
  const markers = language === 'zh' ? [MARKER_TODO_EN, MARKER_TODO_ZH] : [MARKER_TODO_EN]
  return { checkbox: TODO_LINE, markers }
}

/**
 * CJK scripts and full-width forms priced denser than ASCII: Han (中文), kana
 * (日文), hangul (韩文), plus CJK punctuation and full-width variants. CJK is
 * not only Chinese — every script here encodes a character in roughly one
 * token in real tokenizers.
 */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g

/**
 * Token heuristic, selectable by the `tokenEstimate` config:
 *
 * - `cjk` (default): CJK scripts at ~2 chars/token, ASCII at 4. The host
 *   meter prices every character at 4/token, which matches English but
 *   underestimates CJK by ~2x, so CJK-heavy regions get compacted late and
 *   starved of budget. This mode prices all CJK scripts near reality while
 *   staying identical to the host for pure-ASCII text.
 * - `ascii`: flat 4 chars/token for every character — exactly the host
 *   meter's numbers, for users who want byte-identical behavior.
 *
 * @param {string} text - text to price.
 * @param {'cjk'|'ascii'} [mode] - pricing mode.
 * @returns {number} estimated tokens.
 */
export function estimateTextTokens(text, mode = 'cjk') {
  const source = String(text)
  if (mode === 'ascii') return Math.ceil(source.length / 4)
  const cjk = (source.match(CJK_CHAR) ?? []).length
  return Math.ceil(cjk / 2 + (source.length - cjk) / 4)
}

/**
 * Token estimate for one message: text blocks, tool-call arguments, and
 * tool-result payloads (the same content the host meter prices, minus its
 * per-block overhead).
 *
 * @param {{ content?: Array<{ type: string }> }} message - any message-shaped object.
 * @param {'cjk'|'ascii'} [mode] - pricing mode, see {@link estimateTextTokens}.
 * @returns {number} estimated tokens.
 */
export function estimateMessageTokens(message, mode = 'cjk') {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(block.arguments)
    else if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return estimateTextTokens(parts.join('\n'), mode)
}

const i18n = Object.freeze({
  en: Object.freeze({
    none: '(none)',
    elidedIntents: '({n} earlier user messages elided)',
    elidedErrors: '({n} earlier errors elided)',
    dedupNote: '{tool}({args}) ran {n}x — identical repeats, latest result kept in the retained tail',
    contextNote: '{messages} messages / {calls} tool calls compacted deterministically by dsh-dcp (no LLM summarization call)',
    carried: 'carried from prior checkpoint',
    terseHeader: '{messages} messages ({calls} tool calls) compacted deterministically by dsh-dcp.',
  }),
  zh: Object.freeze({
    none: '（无）',
    elidedIntents: '（省略 {n} 条较早的用户消息）',
    elidedErrors: '（省略 {n} 条较早的报错）',
    dedupNote: '{tool}({args}) 执行了 {n} 次 —— 重复调用，仅保留最近一次结果',
    contextNote: 'dsh-dcp 确定性压缩了 {messages} 条消息 / {calls} 次工具调用（未调用 LLM 摘要）',
    carried: '继承自上一次压缩检查点',
    terseHeader: 'dsh-dcp 确定性压缩了 {messages} 条消息（{calls} 次工具调用）。',
  }),
})

/** Collapse whitespace and hard-cap one item's length with an ellipsis. */
export function clip(text, maxChars) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : flat.slice(0, maxChars - 1) + '…'
}

/** Message text blocks joined with newlines (tool results and reasoning excluded). */
function textOf(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Tool-result blocks flattened as text, first non-empty line kept per block. */
function resultFirstLines(blocks) {
  const lines = []
  for (const block of blocks) {
    if (block.type !== 'tool-result') continue
    const text = block.content
      .filter((inner) => inner.type === 'text')
      .map((inner) => inner.text)
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (text !== undefined) lines.push({ isError: block.isError === true, line: text })
  }
  return lines
}

/**
 * Parse one prior checkpoint text into its `## ` sections.
 * @returns {Map<string, string[]>} header → bullet/item lines (markers stripped).
 */
export function parseCheckpointSections(text) {
  const inner = text.includes(SUMMARY_OPEN_TAG)
    ? text.slice(text.indexOf(SUMMARY_OPEN_TAG) + SUMMARY_OPEN_TAG.length, text.lastIndexOf(SUMMARY_CLOSE_TAG))
    : text
  const sections = new Map()
  let header = ''
  for (const line of inner.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      header = match[1]
      if (!sections.has(header)) sections.set(header, [])
      continue
    }
    if (header !== '' && line.trim().length > 0) sections.get(header).push(line.trim().replace(/^[-*]\s+/, ''))
  }
  return sections
}

/** File path named by a parsed tool-call argument, when there is one. */
function argPath(parsed) {
  if (parsed === undefined || parsed === null) return undefined
  for (const key of PATH_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Shell command named by a parsed tool-call argument, when there is one. */
function argCommand(parsed) {
  if (parsed === undefined || parsed === null) return undefined
  for (const key of COMMAND_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Short display form of one call's arguments for dedup notes. */
function argDisplay(name, parsed) {
  const path = argPath(parsed)
  if (path !== undefined) return clip(path, 80)
  const command = argCommand(parsed)
  if (command !== undefined) return clip(command, 80)
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    const first = Object.values(parsed).find((value) => typeof value === 'string' && value.length > 0)
    if (first !== undefined) return clip(first, 80)
  }
  return ''
}

/**
 * Walk the replayed region and collect every deterministic fact.
 *
 * @param {import('@deepseek-ai/dsh-llm').Message[]} messages - region messages in surface order.
 * @param {'en'|'zh'} [language] - which error/todo keyword set applies; `zh` also
 *   recognizes localized (Chinese) failures and `待办` markers.
 * @returns {object} the extracted fact bundle.
 */
export function extractFacts(messages, language = 'en') {
  const facts = {
    messageCount: messages.length,
    intents: [],
    files: new Map(),
    commands: [],
    errors: [],
    pendingTodos: [],
    concepts: new Set(),
    dupCounts: new Map(),
    toolCallCount: 0,
    lastUserText: '',
    lastAssistantText: '',
    carried: new Map(),
  }
  const callsById = new Map()
  const errorRegexes = errorPatterns(language)
  const { checkbox, markers } = todoPatterns(language)

  const rememberTodoLines = (text) => {
    checkbox.lastIndex = 0
    for (const match of text.matchAll(checkbox)) {
      const item = match[2].trim()
      if (item.length === 0) continue
      if (match[1] === ' ') {
        if (!facts.pendingTodos.some((existing) => existing === item)) facts.pendingTodos.push(item)
      } else {
        const index = facts.pendingTodos.indexOf(item)
        if (index !== -1) facts.pendingTodos.splice(index, 1)
      }
    }
    for (const pattern of markers) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const item = match[1].trim()
        if (item.length > 0 && !facts.pendingTodos.some((existing) => existing === item)) facts.pendingTodos.push(item)
      }
    }
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = textOf(message)
      if (text.trim().length > 0) {
        facts.lastAssistantText = text
        rememberTodoLines(text)
      }
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        facts.toolCallCount += 1
        let parsed
        try {
          parsed = JSON.parse(block.arguments)
        } catch {
          parsed = undefined
        }
        const info = { name: block.name, parsed }
        callsById.set(block.id, info)

        const path = argPath(parsed)
        if (path !== undefined) {
          const entry = facts.files.get(path) ?? { reads: 0, writes: 0 }
          if (WRITE_TOOL.test(block.name)) entry.writes += 1
          else entry.reads += 1
          facts.files.set(path, entry)
          const extension = /\.([a-z0-9]{1,5})$/i.exec(path)
          if (extension !== null) facts.concepts.add(extension[1].toLowerCase())
        }
        const command = argCommand(parsed)
        if (command !== undefined) {
          facts.commands.push(command)
          for (const match of command.match(COMMAND_CONCEPTS) ?? []) facts.concepts.add(match.toLowerCase())
        }
        const key = `${block.name}\u0000${block.arguments}`
        const dup = facts.dupCounts.get(key) ?? { name: block.name, parsed, count: 0 }
        dup.count += 1
        facts.dupCounts.set(key, dup)
      }
      continue
    }

    // user-role messages: tool results, prior checkpoints, real user text
    const results = resultFirstLines(message.content)
    if (results.length > 0) {
      for (const result of results) {
        const isError = result.isError || errorRegexes.some((pattern) => pattern.test(result.line))
        if (!isError) continue
        const call = message.source?.kind === 'tool' ? callsById.get(message.source.callId) : undefined
        const who = call === undefined ? 'tool' : call.name
        facts.errors.push(`${who}: ${result.line}`)
      }
      continue
    }
    const text = textOf(message)
    if (text.trim().length === 0) continue
    if (message.source?.kind === 'plugin' && message.source.plugin === 'compact') {
      facts.carried = parseCheckpointSections(text)
      continue
    }
    facts.lastUserText = text
    facts.intents.push(text)
    rememberTodoLines(text)
  }

  for (const command of facts.commands) facts.concepts.add(command.split(/\s+/)[0]?.toLowerCase() ?? '')
  return facts
}

/** Merge carried checkpoint lines with freshly extracted ones, deduped in order. */
function mergeCarried(facts, maxItems) {
  const carriedOf = (header) => facts.carried.get(header) ?? []
  const dedupe = (lines) => {
    const seen = new Set()
    const merged = []
    for (const line of lines) {
      const key = line.toLowerCase().replace(/[^a-z0-9/\u4e00-\u9fff]/g, '')
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      merged.push(line)
    }
    return merged
  }
  const withElision = (lines, elidedTemplate, t) => {
    if (lines.length <= maxItems) return lines
    const kept = lines.slice(-Math.max(1, maxItems - 1))
    kept.unshift(t(elidedTemplate).replace('{n}', String(lines.length - kept.length)))
    return kept
  }
  const mergeFileLines = (fresh, carried) => {
    const freshPaths = new Set(fresh.map((line) => line.split(/\s+[—-]\s+/)[0]?.trim() ?? line))
    const survivors = carried.filter((line) => {
      const path = line.split(/\s+[—-]\s+/)[0]?.trim() ?? line
      return !freshPaths.has(path)
    })
    return [...fresh, ...survivors]
  }
  return { carriedOf, dedupe, withElision, mergeFileLines }
}

/** Render one section with bullets, or the localized "(none)"; null when dropped. */
function renderSection(header, items, t, dropEmpty) {
  const unique = [...new Set(items.filter((item) => item !== undefined && item !== null && String(item).trim().length > 0))]
  if (dropEmpty && unique.length === 0) return null
  const body = unique.length === 0 ? [t('none')] : unique.map((item) => `- ${item}`)
  return [`## ${header}`, ...body, '']
}

/**
 * Compose the deterministic checkpoint summary.
 *
 * @param {object} facts - {@link extractFacts} output.
 * @param {object} options - resolved dcp config plus degradation knobs.
 * @returns {string} markdown summary text.
 */
export function composeSummary(facts, options) {
  const { maxItems, maxItemChars, language, dedup, purgeErrors, protectedTools = [], sectionCap = maxItems, itemChars = maxItemChars, dropEmpty = false } = options
  const t = (key) => i18n[language][key]
  const { carriedOf, dedupe, withElision, mergeFileLines } = mergeCarried(facts, sectionCap)

  const intents = dedupe([
    ...carriedOf(SECTIONS.intent),
    ...facts.intents.map((text) => clip(text, itemChars)),
  ])
  const intentItems = withElision(intents, 'elidedIntents', t)

  const conceptItems = dedupe([...carriedOf(SECTIONS.concepts), ...facts.concepts])

  const freshFileItems = [...facts.files.entries()].map(([path, ops]) =>
    clip(`${path} — ${ops.writes > 0 ? `W×${ops.writes}${ops.reads > 0 ? ` R×${ops.reads}` : ''}` : `R×${ops.reads}`}`, itemChars),
  )
  const fileItems = dedupe(mergeFileLines(freshFileItems, carriedOf(SECTIONS.files))).slice(0, sectionCap)

  // purgeErrors collapses older errors to an elision note (most recent kept);
  // when disabled every distinct error survives up to the section cap.
  const errorItems = dedupe([...carriedOf(SECTIONS.errors), ...facts.errors.map((line) => clip(line, itemChars))])
  const errorLines = (purgeErrors ? withElision(errorItems, 'elidedErrors', t) : errorItems).slice(0, sectionCap)

  const todoItems = facts.pendingTodos.map((item) => clip(item, itemChars)).slice(0, sectionCap)

  const currentItems = []
  if (facts.lastUserText.trim().length > 0) currentItems.push(clip(facts.lastUserText, itemChars))
  if (facts.lastAssistantText.trim().length > 0) {
    currentItems.push(clip(facts.lastAssistantText.split('\n').filter((line) => line.trim().length > 0).slice(0, 2).join(' / '), itemChars))
  }

  const nextItem = todoItems.length > 0 ? todoItems[todoItems.length - 1] : t('none')

  const contextItems = [...carriedOf(SECTIONS.context)]
  if (dedup) {
    for (const dup of facts.dupCounts.values()) {
      if (dup.count < 2) continue
      const isProtected = protectedTools.some((p) => dup.name.includes(p))
      if (isProtected) continue
      const args = argDisplay(dup.name, dup.parsed)
      contextItems.push(t('dedupNote').replace('{tool}', dup.name).replace('{args}', args).replace('{n}', String(dup.count)))
    }
  }
  contextItems.push(t('contextNote').replace('{messages}', String(facts.messageCount)).replace('{calls}', String(facts.toolCallCount)))

  const blocks = [
    renderSection(SECTIONS.intent, intentItems, t, dropEmpty),
    renderSection(SECTIONS.concepts, conceptItems, t, dropEmpty),
    renderSection(SECTIONS.files, fileItems, t, dropEmpty),
    renderSection(SECTIONS.errors, errorLines, t, dropEmpty),
    renderSection(SECTIONS.todos, todoItems, t, dropEmpty),
    renderSection(SECTIONS.current, currentItems, t, dropEmpty),
    renderSection(SECTIONS.next, [nextItem], t, dropEmpty),
    renderSection(SECTIONS.context, contextItems, t, dropEmpty),
  ]
  return blocks
    .filter((section) => section !== null)
    .map((section) => section.join('\n'))
    .join('\n')
    .trim()
}

/** Last-resort fixed-shape summary for pathological budget situations. */
function composeTerse(facts, t, itemChars) {
  const files = [...facts.files.keys()].slice(0, 12).join(', ')
  const lastError = facts.errors.length > 0 ? clip(facts.errors[facts.errors.length - 1], Math.min(itemChars, 120)) : t('none')
  const next = facts.pendingTodos.length > 0 ? clip(facts.pendingTodos[facts.pendingTodos.length - 1], Math.min(itemChars, 120)) : t('none')
  const carriedIntents = (facts.carried.get(SECTIONS.intent) ?? []).slice(0, 3).map((line) => clip(line, Math.min(itemChars, 100)))
  const lines = [
    t('terseHeader').replace('{messages}', String(facts.messageCount)).replace('{calls}', String(facts.toolCallCount)),
    `Request: ${clip(facts.lastUserText || carriedIntents[0] || t('none'), 160)}`,
    files.length > 0 ? `Files: ${files}` : `Files: ${t('none')}`,
    `Errors: ${lastError}`,
    `Next: ${next}`,
    ...carriedIntents.map((line) => `Prior: ${line}`),
  ]
  return lines.join('\n').trim()
}

/**
 * Deterministically summarize one compaction region under a token budget.
 *
 * Budgets with the CJK-aware estimator by default (honoring
 * `dcp.tokenEstimate`); an explicit estimator may be supplied to mirror a
 * different meter.
 *
 * @param {{ messages: import('@deepseek-ai/dsh-llm').Message[] }} input - replayed region.
 * @param {object} dcp - resolved dcp config.
 * @param {(message: unknown) => number} [estimateMessageLike] - token estimator; defaults to {@link estimateMessageTokens}.
 * @returns {{ summary: { type: 'text', text: string }[], provider: string, model: string }}
 */
export function summarizeDeterministically(input, dcp, estimateMessageLike = (message) => estimateMessageTokens(message, dcp.tokenEstimate)) {
  const facts = extractFacts(input.messages, dcp.language)
  const regionTokens = input.messages.reduce((total, message) => total + estimateMessageLike(message), 0)
  const targetTokens = Math.min(dcp.maxSummaryTokens, Math.floor(regionTokens * 0.45))
  const estimate = (text) => estimateMessageLike({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

  const attempts = [
    () => composeSummary(facts, dcp),
    () => composeSummary(facts, { ...dcp, sectionCap: 3, itemChars: 80, dropEmpty: true }),
    () => composeSummary(facts, { ...dcp, sectionCap: 2, itemChars: 60, dropEmpty: true }),
    () => composeTerse(facts, (key) => i18n[dcp.language][key], dcp.maxItemChars),
  ]

  let text = attempts[0]()
  for (const attempt of attempts.slice(1)) {
    if (estimate(text) <= targetTokens) break
    text = attempt()
  }
  if (estimate(text) > targetTokens) {
    text = text.slice(0, Math.max(40, targetTokens * 3)).trim()
  }

  return {
    summary: [{ type: 'text', text }],
    provider: 'dsh-dcp',
    model: 'deterministic-v1',
  }
}
