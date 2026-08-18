# dsh-dcp

Deterministic context-compaction backend for dsh (DeepSeek Harness): **context
compaction without an LLM call**, works out of the box.

> [简体中文](README.md) · **English**

## Why

dsh compacts conversation context by default with `compaction-basic`, which
asks an LLM to re-summarize older messages on every compaction — costly, slow,
and non-deterministic. dsh-dcp is a pure-code port of the ideas behind
[opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
(dedup, error cleanup, "technical summary instead of prose"):

- **Zero LLM calls**: compaction itself costs no extra tokens
- **Deterministic**: identical input always yields identical output
- **CJK-friendly**: verbatim user text / paths / commands / errors, priced at
  real CJK density
- **Inherits all official safety**: triggers, retained tail, transaction
  locks, tool-pairing — dsh's own machinery, only the summarizer is replaced

## Effects

### vs. the official compaction-basic

| | compaction-basic | dsh-dcp |
|---|---|---|
| Summarization | LLM rewrite per compaction | deterministic code extraction |
| LLM calls per compaction | 1 | **0** |
| Determinism | may differ run to run | identical input → identical output |
| Summary content | semantic | verbatim hard facts (paths/commands/errors/todos/user text) |
| Chinese | model re-transcribes | kept verbatim + CJK-aware pricing |
| Triggers/retention/overflow/safety | official | **inherited, identical** |
| Checkpoint format | official | compatible (mutually mergeable) |

It also borrows the dedup / error-purge / `/dcp` / technical-summary ideas from
[opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning),
re-implemented against dsh's compaction seam — that one serves opencode, this
one serves dsh.

### CJK adaptation

Content is kept verbatim (no re-transcription into English); tokens are priced
at real CJK density (~2 chars/token for Chinese/Japanese/Korean/full-width)
instead of the host's flat 4 chars/token that underestimates Chinese — so CJK
sessions get a budget that reflects real cost, and checkpoints stay
information-dense.

### Real dsh session

~80k tokens of history → ~700-token checkpoint (**~100x**), zero LLM calls;
cache-hit rate is barely affected (any backend pays one "cold request" right
after a compaction).

A checkpoint produced on a real session (Chinese content kept verbatim):

```
## Primary Request and Intent
- 帮我把登录页的重定向 bug 修掉

## Files and Code
- /app/src/auth/login.ts — W×1 R×1

## Errors and Fixes
- bash: FAIL src/auth.test.ts

## Pending Jobs
- add regression test

## Critical Context
- dsh-dcp 确定性压缩了 12 条消息 / 8 次工具调用（未调用 LLM 摘要）
```

## Not in scope

- **No semantic summarization**: it preserves facts that appeared, it does not
  "understand" code. Need deep semantic checkpoints? Stick with the official
  `compaction-basic`
- **Things dsh already does, deliberately not re-implemented**:
  - tool-result pruning (`compaction-tool-result-pruner`, deterministic by size)
  - trigger policy, retained tail, overflow recovery (inherited from official)
  - `/compact` command, UI checkpoint cards (shipped with dsh)

## Install

**Recommended: pair it with our dsh-tui-pi** (the TUI already depends on
dsh-dcp):

```bash
npm i @aiwayds/dsh-tui-pi
dsh plugin add @aiwayds/dsh-dcp     # activates dcp; the bundle auto-mounts
```

**Standalone:**

```bash
npm i @aiwayds/dsh-dcp
npx dsh-dcp-setup                   # safe: date-stamped backup → append-only → idempotent checks
```

> dsh-dcp plugs into dsh's compaction seam and only affects profiles that
> mount it. The web profile does not bundle the TUI, so it keeps the official
> backend and is unaffected.

## /dcp command

| Command | Effect |
|---|---|
| `/dcp` | status: config, compaction count, tokens saved |
| `/dcp compact` | compact now (zero LLM) |
| `/dcp set <k> <v>` | adjust a knob for this session, with a persist hint |

Settable: `dedup`, `purgeErrors`, `maxItems`, `maxItemChars`,
`maxSummaryTokens`, `language`, `tokenEstimate`, `thresholdRatio`.

## Configuration

All optional, defaults work out of the box:

| Key | Default | Meaning |
|---|---|---|
| `thresholdRatio` | 0.7 | compaction trigger; 0.7 recommended for CJK-heavy sessions |
| `language` | `zh` | summary language; `zh` also enables Chinese error/"待办：" detection |
| `tokenEstimate` | `cjk` | CJK (zh/ja/ko/full-width) at ~2 chars/token; `ascii` matches the host |
| `dedup` | `true` | annotate repeated tool calls |
| `purgeErrors` | `true` | collapse stale errors into one note |
| `maxItems` / `maxItemChars` | 10 / 200 | summary density |
| `maxSummaryTokens` | 2048 | summary token budget |

## Design reference

- [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- dsh official compaction seam: `docs/subsystems/compaction.md` (deepseek-harness)

## Development

```bash
npm install && npm test     # 45 tests: extractor/compaction/command/config/setup
```

## License

MIT
