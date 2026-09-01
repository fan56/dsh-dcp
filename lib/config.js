/**
 * dsh-dcp configuration: the dcp-specific knobs layered on top of
 * compaction-basic's policy keys. Everything here is optional — the resolved
 * defaults are the documented out-of-the-box behavior.
 *
 * @module dsh-dcp/config
 */

/** dcp-specific keys this plugin adds on top of compaction-basic. */
export const DCP_CONFIG_KEYS = [
  'dedup',
  'purgeErrors',
  'maxItems',
  'maxItemChars',
  'maxSummaryTokens',
  'language',
  'tokenEstimate',
  'protectedTools',
  'roundInterval',
  'notice',
]

/** compaction-basic policy keys forwarded to the parent engine verbatim. */
export const BASIC_CONFIG_KEYS = [
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
]

const DEFAULTS = Object.freeze({
  dedup: true,
  purgeErrors: true,
  maxItems: 10,
  maxItemChars: 200,
  maxSummaryTokens: 2048,
  language: 'en',
  tokenEstimate: 'cjk',
  protectedTools: Object.freeze(['write', 'edit', 'apply_patch']),
  roundInterval: 50,
  notice: true,
})

/**
 * Split one loader-level plugin config into the parent engine's keys and the
 * dcp keys, rejecting unknown keys loudly (mirrors compaction-basic's own
 * fail-fast validation so typos never hide behind defaults).
 *
 * @param {Record<string, unknown>} config - untrusted plugin configuration.
 * @returns {{ basic: Record<string, unknown>, dcp: Record<string, unknown> }}
 */
export function splitConfig(config = {}) {
  const known = new Set([...BASIC_CONFIG_KEYS, ...DCP_CONFIG_KEYS])
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`DcpConfig: unknown key "${key}"`)
  }
  const basic = /** @type {Record<string, unknown>} */ ({})
  for (const key of BASIC_CONFIG_KEYS) {
    if (config[key] !== undefined) basic[key] = config[key]
  }
  const dcp = /** @type {Record<string, unknown>} */ ({})
  for (const key of DCP_CONFIG_KEYS) {
    if (config[key] !== undefined) dcp[key] = config[key]
  }
  return { basic, dcp }
}

/**
 * Validate and resolve dcp defaults.
 *
 * @param {Record<string, unknown>} raw - the dcp half of {@link splitConfig}.
 * @returns {Readonly<{dedup: boolean, purgeErrors: boolean, maxItems: number, maxItemChars: number, maxSummaryTokens: number, language: 'en'|'zh', tokenEstimate: 'cjk'|'ascii', protectedTools: readonly string[], roundInterval: number, notice: boolean}>}
 */
export function resolveDcpConfig(raw = {}) {
  if (raw.dedup !== undefined && typeof raw.dedup !== 'boolean') {
    throw new Error('DcpConfig: dedup must be a boolean')
  }
  if (raw.purgeErrors !== undefined && typeof raw.purgeErrors !== 'boolean') {
    throw new Error('DcpConfig: purgeErrors must be a boolean')
  }
  if (raw.language !== undefined && raw.language !== 'en' && raw.language !== 'zh') {
    throw new Error('DcpConfig: language must be "en" or "zh"')
  }
  if (raw.tokenEstimate !== undefined && raw.tokenEstimate !== 'cjk' && raw.tokenEstimate !== 'ascii') {
    throw new Error('DcpConfig: tokenEstimate must be "cjk" or "ascii"')
  }
  for (const key of ['maxItems', 'maxItemChars', 'maxSummaryTokens']) {
    const value = raw[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
      throw new Error(`DcpConfig: ${key} (${String(value)}) must be a positive integer`)
    }
  }
  if (raw.protectedTools !== undefined) {
    if (!Array.isArray(raw.protectedTools) || raw.protectedTools.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error('DcpConfig: protectedTools must be an array of non-empty strings')
    }
  }
  if (raw.roundInterval !== undefined) {
    const value = raw.roundInterval
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('DcpConfig: roundInterval must be a non-negative integer (0 disables the round trigger)')
    }
  }
  if (raw.notice !== undefined && typeof raw.notice !== 'boolean') {
    throw new Error('DcpConfig: notice must be a boolean')
  }
  return Object.freeze({ ...DEFAULTS, ...raw })
}

/** Keys `/dcp set` may adjust at runtime, with their value kind for parsing. */
export const RUNTIME_SETTABLE = Object.freeze({
  dedup: 'boolean',
  purgeErrors: 'boolean',
  maxItems: 'positive-integer',
  maxItemChars: 'positive-integer',
  maxSummaryTokens: 'positive-integer',
  language: 'language',
  tokenEstimate: 'token-estimate',
  thresholdRatio: 'ratio',
  roundInterval: 'nonnegative-integer',
  notice: 'boolean',
})
