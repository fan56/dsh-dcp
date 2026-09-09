import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { SKILL_DESCRIPTION, SKILL_PROVIDER_NAME, skillProvider, stripFrontmatter } from '../lib/skill.js'

/**
 * Bundled-skill tests exercise lib/skill.js directly: the engine is not
 * constructed here (its mock contexts live in engine/triggers/service-receiver
 * tests), so no cordis mock is needed — the provider is a plain object.
 */

/** Extract one scalar value from the SKILL.md YAML frontmatter. */
function frontmatterValue(markdown, key) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'SKILL.md must open with a YAML frontmatter block')
  const line = match[1]
    .split('\n')
    .find((entry) => entry.startsWith(`${key}:`))
  assert.ok(line, `frontmatter must declare "${key}"`)
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/s, '$1')
}

test('provider exposes the bundled dsh-dcp candidate with valid metadata', async () => {
  assert.equal(skillProvider.name, SKILL_PROVIDER_NAME)
  assert.equal(SKILL_PROVIDER_NAME, 'dsh-dcp-config')

  const candidates = await skillProvider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'dsh-dcp-config')
  assert.equal(candidate.provider, 'dsh-dcp-config')
  assert.equal(candidate.source, 'bundled')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(candidate.description.length > 0)
  assert.ok(candidate.description.length <= 500, 'description must stay within the 500-char routing budget')
  // The directory resource base must point at the packaged skills/ directory
  // (fileURLToPath keeps the trailing slash of the URL path).
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(
    candidate.resourceBase.path.replace(/\/$/, '').endsWith('skills/dsh-dcp-config'),
    `unexpected resourceBase path: ${candidate.resourceBase.path}`,
  )
})

test('provider.get loads the packaged SKILL.md with matching metadata', async () => {
  const [candidate] = await skillProvider.list({})

  const definition = await skillProvider.get(candidate, {})
  assert.equal(definition.name, 'dsh-dcp-config')
  assert.equal(definition.provider, 'dsh-dcp-config')
  assert.equal(definition.description, candidate.description)
  // SkillDefinition.content is the instruction body after metadata removal:
  // the bundled get() must strip the raw frontmatter the file keeps for the
  // GitHub/manual install paths (same shape the filesystem provider serves).
  assert.ok(!definition.content.startsWith('---'), 'get() must not serve the frontmatter block')
  assert.ok(definition.content.includes('# dsh-dcp 使用指南'), 'body must be the packaged skill markdown')

  // Anti-drift: the hardcoded routing description must equal the SKILL.md
  // frontmatter, and the frontmatter itself must satisfy the registry grammar.
  const markdown = await readFile(new URL('../skills/dsh-dcp-config/SKILL.md', import.meta.url), 'utf8')
  assert.equal(frontmatterValue(markdown, 'name'), 'dsh-dcp-config')
  assert.equal(frontmatterValue(markdown, 'description'), SKILL_DESCRIPTION)
  assert.equal(SKILL_DESCRIPTION, candidate.description)
})

test('stripFrontmatter tolerates missing or unclosed frontmatter', () => {
  // No frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('plain body\n'), 'plain body\n')
  assert.equal(stripFrontmatter(''), '')
  // A `---` fence that never closes is not frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('---\nname: x'), '---\nname: x')
  assert.equal(stripFrontmatter('---'), '---')
  // A closed block is stripped down to the trimmed instruction body.
  assert.equal(stripFrontmatter('---\nname: x\n---\n\n# Body\n'), '# Body')
  // CRLF line endings are tolerated on both fence lines.
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\n\r\n# Body\r\n'), '# Body')
})
