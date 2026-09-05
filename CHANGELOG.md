# Changelog

All notable changes to dsh-dcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.0] - 2026-09-05

### Added
- **`dsh-dcp-setup --remove`** — the reverse of the mount operation (same target forms: default home patch, `--profile <name>`, or an explicit file path). It strips only the setup-written mount block (marker-identified, user-tuned config included), backs the file up date-stamped first, and deletes the file when nothing else remains. Uninstalling the package without this step left the mount pointing at the vanished absolute entry path, failing the profile boot with module-not-found.

### Changed
- The `compaction-basic` disable row now carries a `name` guard (`@deepseek-ai/dsh-compaction-basic`) — a future host rename skips the row with a loader warning instead of silently disabling an unrelated component (the same pattern dsh-tui-pi's patch uses).
- The boot smoke drives the full setup mount → compose → remove lifecycle against a real host and asserts the recomposed tree returns to stock; uninstall sections added to both READMEs.
