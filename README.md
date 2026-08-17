# dsh-dcp

[dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）的**确定性 context 压缩后端**：把 `compaction-basic` 的 LLM 摘要换成纯代码抽取，**每次压缩零 LLM 调用**。

设计参考 [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（opencode 社区的 context 剪枝插件，即 oh-my-openagent 所用的 opencode-dcp）：重复调用去重、陈旧报错清理、"技术性摘要代替散文"、`/dcp` 命令、默认配置开箱即用——按 dsh 的 compaction capability seam 重新实现。

## 为什么

dsh 自带三层压缩里，`compaction-basic` 每次压缩都要付一次 LLM 摘要调用，且摘要质量取决于模型心情。dsh-dcp 换成确定性模板抽取：

- **零 LLM 调用**：压缩触发不再产生额外的 token 消耗
- **输出稳定**：相同输入永远得到相同摘要（可 diff、可测试）
- **保留硬信息**：文件路径、命令、报错串、待办、用户原话逐字保留，废话全丢
- **中文友好**：内容原样保留（不做英文转写），`thresholdRatio` 可直接调低提前触发
- **继承一切安全机制**：压力触发、保留尾巴、溢出恢复、事务锁、tool-pairing 边界全部复用官方实现（只 override 官方留的唯一钩子 `summarize()`）

## 快速开始

```bash
# 1. 克隆并安装（依赖与 dsh 0.1.0-rc.6 对齐）
git clone git@github.com:fan56/dsh-dcp.git ~/github/dsh-dcp
cd ~/github/dsh-dcp && npm install

# 2. 挂载：在 ~/.dsh/cordis.patch.yml 追加（name 必须是绝对路径）
# - id: compaction-basic
#   name: /Users/<you>/github/dsh-dcp/lib/index.js

# 3. 重启 dsh，输入 /dcp 验证
```

`/compact` 命令、自动压力触发、overflow 恢复、UI 的 checkpoint 卡片照常工作——它们只依赖 `ctx.compaction` 接口，与本后端无关。

## `/dcp` 命令

| 命令 | 作用 |
|---|---|
| `/dcp` | 状态：当前配置、压缩次数、shadowed token 数、省掉的 LLM 调用数 |
| `/dcp compact` | 立即压缩（确定性，无 LLM 调用；等价 `/compact`） |
| `/dcp set <k> <v>` | 本会话内调整参数，并打印持久化到 `cordis.patch.yml` 的片段 |
| `/dcp help` | 用法 |

可调键：`dedup`、`purgeErrors`、`maxItems`、`maxItemChars`、`maxSummaryTokens`、`language`、`thresholdRatio`。

## 配置

全部可选，默认即用。写在 `~/.dsh/cordis.patch.yml` 的 `config:` 下：

```yaml
- id: compaction-basic
  name: /Users/<you>/github/dsh-dcp/lib/index.js
  config:
    thresholdRatio: 0.7   # 中文场景建议 0.7（默认 0.8）
    language: zh          # 摘要填充文案 en|zh（内容本身总是逐字保留）
```

### dsh-dcp 自己的键

| 键 | 默认 | 说明 |
|---|---|---|
| `dedup` | `true` | 统计重复的工具调用（同名+同参），在 Critical Context 里标注"×N，保留最近结果" |
| `purgeErrors` | `true` | 旧报错折叠为一条省略提示，只保留最近 `maxItems` 条 |
| `maxItems` | `10` | 每个 section 最多条数 |
| `maxItemChars` | `200` | 每条最长字符（超出截断加 `…`） |
| `maxSummaryTokens` | `2048` | 摘要 token 预算（超出自动降级到更紧凑的格式） |
| `language` | `en` | 填充文案语言；section 标题固定英文（对下游模型是结构锚点） |

### 继承自 compaction-basic 的键

`thresholdRatio`（0.8）、`retainRatio`（0.16）、`retainTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`、`auto` 等原样透传，语义见 [dsh-compaction-basic README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md)。`summarizationProvider/Model/maxTokens` 只影响被替换掉的 LLM 摘要路径，保留只为配置兼容。

## 摘要长什么样

```
## Primary Request and Intent
- Fix the login redirect bug and update README.

## Files and Code
- /app/src/auth/login.ts — W×1 R×1

## Errors and Fixes
- bash: FAIL src/auth.test.ts

## Pending Jobs
- add regression test

## Current Work
- Fix the login redirect bug and update README.

## Next Step
- add regression test

## Critical Context
- dsh-dcp 确定性压缩了 12 条消息 / 8 次工具调用（未调用 LLM 摘要）
```

Section 结构与 `compaction-basic` 的 checkpoint 指令一致，因此：已有的 `<compacted-summary>` 检查点会被解析、去重后合并进新摘要（陈旧的 Current Work / Next Step 丢弃重生成）；将来换回 basic 后端，它也能按官方规则合并 dsh-dcp 产生的检查点。

## 工作原理

```
BasicCompactionEngine            dsh 官方：阈值/保留/事务/事件锁/tool-pairing
        ▲
        │ 仅 override summarize()
DcpEngine ── register /dcp
        │
summarizeDeterministically()     纯代码：抽取 → 合并 prior checkpoint → 预算压缩
```

- 压缩区间选择、`compaction/start → summary → end` 事件序、`surfaceOp: replace`、收敛校验（摘要必须小于被压区间）、`ManualCompactionError` 错误分类，全部由父类承担
- 摘要预算 = `min(maxSummaryTokens, 45% × 被压区间)`，用宿主同一个 token meter 估算；超出时逐级降级（砍条数 → 丢空 section → terse 固定格式 → 硬截断），保证收敛校验通过
- 挂载方式是 `cordis.patch.yml` 按 `id: compaction-basic` 覆盖 `name`，行 id 不变、仍留在原 isolate 组内，隔离语义不破坏

## 与参考对象的差异

| | opencode-dcp | dsh-dcp |
|---|---|---|
| 宿主 | opencode | dsh（DeepSeek Harness） |
| 接入点 | 插件 + 模型可调的 compress 工具 | 官方 compaction seam 的 `summarize()` 钩子 |
| 历史 | 不改 session，请求前换占位符 | 走官方 durable 替换事务（`surfaceOp: replace`） |
| 摘要 | 模型生成技术摘要 | 确定性模板抽取，零 LLM 调用 |
| 命令 | `/dcp` TUI 面板 + `/dcp-compress` | `/dcp`（status/compact/set） |
| 配置 | `dcp.jsonc`（~30 键） | `cordis.patch.yml` config（6 个自有键） |

## 局限

- 确定性抽取不"理解"代码：它保路径/命令/报错/待办/用户原话，但不做语义归纳。需要语义摘要的场景请继续用默认 `compaction-basic`
- token 计量继承宿主 meter 的 4 字符/token 启发式（中文低估的痛点在宿主侧，见调研文档）
- 依赖绝对路径挂载 + 本目录 `npm install`（私仓未发 npm）；`@deepseek-ai/*` 版本需与本机 dsh 一致（当前 `0.1.0-rc.6`，见 `package.json` 的 `overrides`）

## 开发

```bash
npm install
npm test        # node:test，27 个用例：config / summarizer / command / engine
```

- `lib/index.js` — `DcpEngine`（挂载入口，default export）
- `lib/summarizer.js` — 确定性抽取与预算压缩（纯函数，可独立复用）
- `lib/command.js` — `/dcp` 命令
- `lib/config.js` — 配置切分与校验
- 升级 dsh 后：同步 `package.json` 里 `@deepseek-ai/*` 的版本与 `overrides`，`npm install && npm test`

## License

MIT
