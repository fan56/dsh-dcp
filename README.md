# dsh-dcp

dsh（DeepSeek Harness）的确定性压缩后端：**上下文压缩不调 LLM**，开箱即用。

## 为什么做

dsh 默认的压缩（`compaction-basic`）每次压缩都要让模型把旧对话**重新总结一遍**——费 token、慢、结果还不稳定。我们参考 opencode 社区的 [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（去重、清错、"技术摘要代替散文"），做了一个纯代码版本：

- **零 LLM 调用**：压缩本身不消耗任何额外 token
- **输出稳定**：相同对话永远得到相同摘要
- **中文友好**：用户原话/路径/命令/报错逐字保留，按 CJK 真实密度计价
- **继承官方全部安全机制**：触发、保留尾巴、事务锁、tool-pairing 边界都复用 dsh 官方实现（只替换"摘要"这一环）

## 效果

真实 dsh 会话里压缩出的检查点（中文内容逐字保留）：

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

真实会话实测：一段约 8 万 token 的历史压成约 700 token（**~100x**），全程零 LLM 调用；缓存命中率几乎不变（压缩后总会有一个"冷请求"，任何后端都一样）。

**中文（CJK）适配**：内容逐字保留、不做英文转写；token 计价按 CJK 真实密度（中/日/韩/全角约 2 字符/token），不沿用宿主"4 字符/token"对中文的低估——中文会话的摘要预算反映真实成本，不会被饿死，信息更密集。

**与官方默认压缩的对比**：

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

## 能做什么 / 不能做什么

**能**
- 把旧对话确定性压成检查点，零 LLM 调用
- 保留硬信息：文件路径、命令、报错、待办、用户原话
- 自动去重重复工具调用、清理陈旧报错、合并上一次的检查点
- 压力自动触发、`/compact`、overflow 恢复照常工作

**不能 / 没做**
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
