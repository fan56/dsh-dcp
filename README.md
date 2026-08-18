# dsh-dcp

dsh（DeepSeek Harness）的确定性压缩后端：**上下文压缩不调 LLM**，开箱即用。

> **简体中文**（默认） · [English](#english)

## 为什么做

dsh 默认的压缩（`compaction-basic`）每次压缩都要让模型把旧对话**重新总结一遍**——费 token、慢、结果还不稳定。我们参考 opencode 社区的 [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（去重、清错、"技术摘要代替散文"），做了一个纯代码版本：

- **零 LLM 调用**：压缩本身不消耗任何额外 token
- **输出稳定**：相同对话永远得到相同摘要
- **中文友好**：用户原话/路径/命令/报错逐字保留，按 CJK 真实密度计价
- **继承官方全部安全机制**：触发、保留尾巴、事务锁、tool-pairing 边界都复用 dsh 官方实现（只替换"摘要"这一环）

## 效果

### 与官方默认压缩的对比

| | 官方 compaction-basic | dsh-dcp |
|---|---|---|
| 摘要方式 | 每次调 LLM 重写 | 确定性代码抽取 |
| 每次压缩的模型调用 | 1 次 | **0 次** |
| 输出稳定性 | 同对话多次可能不同 | 相同输入永远相同 |
| 摘要内容 | 语义归纳 | 逐字保硬信息（路径/命令/报错/待办/用户原话） |
| 中文 | 依赖模型转写 | 原样保留 + CJK 计价 |
| 触发/保留/溢出/安全 | 官方 | **继承官方，完全相同** |
| 检查点格式 | 官方 | 兼容（可互相合并） |

设计上还吸收了 [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) 的思路（去重、清错、`/dcp` 命令、技术摘要），但按 dsh 的压缩接口重新实现——它服务于 opencode，dsh-dcp 服务于 dsh。

### CJK 适配

内容逐字保留、不做英文转写；token 计价按 CJK 真实密度（中/日/韩/全角约 2 字符/token），不沿用宿主"4 字符/token"对中文的低估——中文会话的摘要预算反映真实成本，不会被饿死，信息更密集。

### 真实 dsh 会话实测

一段约 8 万 token 的历史压成约 700 token（**~100x**），全程零 LLM 调用；缓存命中率几乎不变（压缩后总会有一个"冷请求"，任何后端都一样）。

真实会话里压缩出的检查点（中文内容逐字保留）：

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

- **不做语义归纳**：不"理解"代码，只保留"出现过的事实"。需要深度语义摘要的场景，请继续用官方 `compaction-basic`
- **dsh 已经有的我们不重复做**：
  - 工具结果剪枝（`compaction-tool-result-pruner`，确定性按大小剪）
  - 触发策略、保留尾巴、溢出恢复（直接继承官方）
  - `/compact` 命令、UI 检查点卡片（dsh 自带）

## 安装

**推荐：配合我们的 dsh-tui-pi 用**（tui 已依赖 dsh-dcp）：

```bash
npm i @aiwayds/dsh-tui-pi
dsh plugin add @aiwayds/dsh-dcp     # 激活 dcp，bundle 自动挂载
```

**独立使用**：

```bash
npm i @aiwayds/dsh-dcp
npx dsh-dcp-setup                   # 安全脚本：带日期备份 → 只追加 → 幂等判断，不碰你已有的配置
```

> dsh-dcp 挂在 dsh 的压缩接口上，只对挂载了它的 profile 生效。web profile 没挂 tui，继续用官方压缩，不受影响。

## /dcp 命令

| 命令 | 作用 |
|---|---|
| `/dcp` | 状态：配置、压缩次数、省下的 token |
| `/dcp compact` | 立即压缩（零 LLM） |
| `/dcp set <k> <v>` | 会话内调参，并提示如何持久化 |

可调键：`dedup`、`purgeErrors`、`maxItems`、`maxItemChars`、`maxSummaryTokens`、`language`、`tokenEstimate`、`thresholdRatio`。

## 配置

全部可选，默认即用：

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholdRatio` | 0.7 | 触发阈值；中文场景建议 0.7 |
| `language` | `zh` | 摘要语言；`zh` 额外识别中文报错和"待办：" |
| `tokenEstimate` | `cjk` | CJK（中/日/韩/全角）按 ~2 字符/token 计价；`ascii` 与宿主一致 |
| `dedup` | `true` | 标注重复工具调用 |
| `purgeErrors` | `true` | 旧报错折叠成一条提示 |
| `maxItems` / `maxItemChars` | 10 / 200 | 摘要密度 |
| `maxSummaryTokens` | 2048 | 摘要 token 预算 |

## 设计参考

- [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- dsh 官方 compaction 接口：`docs/subsystems/compaction.md`（deepseek-harness）

## 开发

```bash
npm install && npm test     # 45 个用例：抽取/压缩/命令/配置/安装脚本
```

## License

MIT

---

# English

## Why

dsh (DeepSeek Harness) compacts conversation context by default with
`compaction-basic`, which asks an LLM to re-summarize older messages on every
compaction — costly, slow, and non-deterministic. dsh-dcp is a pure-code
port of the ideas behind
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
sessions get a budget that reflects real cost, and checkpoints stay information-dense.

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
