# Changelog

All notable changes to dsh-dcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **The bare `/dcp` now compacts** — no-argument invocation runs the same manual deterministic compaction as `/dcp compact` (zero LLM), so the common action takes no subcommand. The was-status bare behavior moves behind `/dcp status`; `help` / `--help` / `-h` print the usage (with an input hint advertising the verbs). `/dcp set` is unchanged. Both READMEs, the bundled `dsh-dcp-config` skill, and the `dsh-dcp-setup` post-install hint (`/dcp status` to verify) follow.

## [0.10.0] - 2026-09-10

### Added

- **Model-switch compaction prompt** — the engine now folds the per-request `request/context` routing snapshot per session (provider or model change alone counts, first request only seeds the baseline), covering every switch entry point: TUI `/model`, web clients, changed default-model settings. New config key `onModelSwitch: 'notice' | 'auto' | 'off'` (default `notice`): `notice` appends one collapsed row suggesting `/dcp compact` first (deterministic, zero LLM) to shadow the old model's history and save tokens; `auto` compacts at the session's next idle boundary through the same seam as the round trigger (label `model-switch`, shared single-flight, `busy`/`cancelled` retry at the next boundary, other failures warn and drop — the pressure trigger remains the safety net); `off` is silent. Two gates guard every mode: switches within 10 assistant messages of the session's last committed compaction are ignored (a guard-rail constant, not a config key — nothing stale has accumulated to shadow), and the new `modelSwitchMinTokens` (default `32768`, `0` disables) requires the host-metered priced surface (`tokenMeter.measure().surfaceTokens`) to reach a floor before a switch is worth announcing — measurement failure fails open. `auto: false` downgrades `auto` to `notice`. Subagent sessions fold independently, mirroring the round trigger's stance. Switch rows answer only to `onModelSwitch`, compaction rows only to `notice`. `/dcp set onModelSwitch <off|notice|auto>` and `/dcp set modelSwitchMinTokens <n>` adjust them in-session; both keys are documented in both READMEs and the bundled `dsh-dcp-config` skill wizard.

### Changed

- The per-session assistant-message counter is now registered unconditionally instead of only under `auto: true`: the model-switch recency gate reads it, and `/dcp set roundInterval N` can arm the round trigger mid-session even when counting started disabled. `auto: false` still registers no automatic compaction paths. No observable trigger behavior change for existing configs.

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
