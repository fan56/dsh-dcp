/**
 * Bundled usage/configuration skill for dsh-dcp.
 *
 * Ships `skills/dsh-dcp-config/SKILL.md` through `ctx.skills.registerProvider`
 * (same mechanism as dsh-llm-proxy and dsh-vault): an agent asked to tune
 * compaction, run `/dcp`, or persist a config change loads the guide
 * automatically instead of guessing at key names and mount shapes.
 *
 * @module dsh-dcp/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The runtime import of '@deepseek-ai/dsh-skill' is deliberately avoided:
// the registry-published dsh-skill lib imports host-closure siblings
// (@deepseek-ai/dsh-scope, dsh-llm — peers of it, but absent from a plugin
// repo's own dependency graph), which dies under pnpm's isolated layout.
// The host injects the real service at runtime; this module only hands it a
// plain provider object.

/** Mirrors dsh-skill's bundled-skill rank (a non-load-bearing ordering hint;
 *  the constant is hardcoded there too). Local copy — see the note above
 *  for why dsh-skill is not loaded at runtime here. */
const BUNDLED_SKILL_RANK = 600

/** Provider name under `ctx.skills`; doubles as the skill name. */
export const SKILL_PROVIDER_NAME = 'dsh-dcp-config'

/** Packaged skill body; `../skills/` resolves to the package root from lib/. */
const SKILL_BODY_URL = new URL('../skills/dsh-dcp-config/SKILL.md', import.meta.url)

/** Resource base served with the skill so its relative links resolve. */
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/dsh-dcp-config/', import.meta.url)),
}

const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

/** Routing description; must stay identical to the SKILL.md frontmatter (asserted in tests). */
export const SKILL_DESCRIPTION = 'dsh 压缩引擎插件（@aiwayds/dsh-dcp）使用与配置指南。凡涉及上下文压缩、/dcp 命令、压缩调参（阈值/密度/语言/轮数触发/模型切换），或要配置 dcp 时先读本指南：/dcp 状态与 /dcp set 十二个可调键、持久化到 cordis.patch.yml 挂载块 config: 段（dsh-dcp-setup 管理）、ask_user_question 调参向导、五类触发（压力/溢出/轮数/模型切换/手动）、subagent 会话独立计数生效。触发词：dcp、压缩、compaction、上下文超限、摘要、thresholdRatio、roundInterval、onModelSwitch。'

const SKILL_CANDIDATE = {
  name: SKILL_PROVIDER_NAME,
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: SKILL_PROVIDER_NAME,
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** The bundled-skill catalog entry, served through the host skill registry. */
export const skillProvider = {
  name: SKILL_PROVIDER_NAME,
  list(_options) {
    return Promise.resolve([SKILL_CANDIDATE])
  },
  async get(_candidate, _options) {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripFrontmatter(await readFile(SKILL_BODY_URL, 'utf8')),
    }
  },
}

/**
 * Strip a leading YAML frontmatter block (`---` / body / `---`) from a skill
 * markdown file. `SkillDefinition.content` must be the instruction body after
 * metadata removal — the same shape the filesystem provider serves — so the
 * bundled SKILL.md, which keeps its frontmatter for the GitHub/manual install
 * paths, has the block removed when served through `skillProvider.get`.
 * Tolerant by design: input that does not open with a `---` line, or whose
 * frontmatter block is never closed, is returned unchanged. Mirrors the
 * delimiter semantics of the upstream skill-filesystem provider.
 */
export function stripFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1).trim()
    }
    if (nextNewline < 0) return raw
    lineStart = nextNewline + 1
  }
  return raw
}
