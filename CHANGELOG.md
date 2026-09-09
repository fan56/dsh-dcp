# Changelog

All notable changes to dsh-dcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.9.1] - 2026-09-09

### Changed
- The bundled skill is renamed `dsh-dcp` → `dsh-dcp-config` (ecosystem-wide convention: config/usage-guide skills end with `-config`). Bundled skills are registered in-process with zero on-disk footprint — updating the package and restarting dsh migrates the name automatically; the old `/dsh-dcp` slash invocation stops resolving. README skill mentions updated.

## [0.9.0] - 2026-09-08

### Added

- **Bundled usage/config skill** — the plugin now registers a `dsh-dcp` skill (`skills/dsh-dcp/SKILL.md`, served through `ctx.skills.registerProvider`, same mechanism as dsh-llm-proxy/dsh-vault). When a session touches compaction tuning, `/dcp`, or persistent dcp configuration, the agent loads the guide automatically: the ten `/dcp set` keys, the `config:` section of the cordis.patch.yml mount block (managed by `dsh-dcp-setup`), an interactive `ask_user_question` tuning wizard (expectation first, then map to keys), the four trigger kinds (pressure/overflow/round/manual), and the per-session subagent counting. The hardcoded routing description is asserted verbatim against the packaged frontmatter by the new anti-drift test (`test/skill.test.mjs`).

## [0.8.0] - 2026-09-05

### Added
- **`dsh-dcp-setup --remove`** — the reverse of the mount operation (same target forms: default home patch, `--profile <name>`, or an explicit file path). It strips only the setup-written mount block (marker-identified, user-tuned config included), backs the file up date-stamped first, and deletes the file when nothing else remains. Uninstalling the package without this step left the mount pointing at the vanished absolute entry path, failing the profile boot with module-not-found.

### Changed
- The `compaction-basic` disable row now carries a `name` guard (`@deepseek-ai/dsh-compaction-basic`) — a future host rename skips the row with a loader warning instead of silently disabling an unrelated component (the same pattern dsh-tui-pi's patch uses).
- The boot smoke drives the full setup mount → compose → remove lifecycle against a real host and asserts the recomposed tree returns to stock; uninstall sections added to both READMEs.
