# dsh-dcp

dsh（DeepSeek Harness）的确定性压缩后端：**上下文压缩不调 LLM**，开箱即用。

**要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

> **简体中文** · [English](README.en.md)

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
  - 触发策略、保留尾巴、溢出恢复（直接继承官方；本插件仅新增轮数触发，见上）
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

可调键：`dedup`、`purgeErrors`、`maxItems`、`maxItemChars`、`maxSummaryTokens`、`language`、`tokenEstimate`、`thresholdRatio`、`roundInterval`、`notice`。

`/dcp` 状态还会列出每个发生过压缩的会话（per-session 概览，含子代理），例如 `per-session: session-1 (2 compactions, ~444 tokens), child (1 compaction, ~22 tokens)`。压缩按会话独立计数；已销毁的会话（含 one-shot 子代理）自动从概览消失；列表封顶一行（最多前 10 个会话，超出显示 `+N more`）。

## 触发条件

| 触发 | 时机 | 说明 |
|---|---|---|
| 压力触发 | 每步请求前 | token ≥ `thresholdRatio`（继承上游默认 0.8；本插件 bundle 挂载默认 0.7，见配置表）× 上下文窗口 |
| 溢出恢复 | 模型报 context 超限时 | 继承官方 |
| **轮数触发** | 会话每收到 `roundInterval` 条 assistant message | 本插件新增；一条 = 一次 LLM 往返（每轮工具迭代各算一条，one-shot 子代理也能触发）。**默认 50**：第 50 条后触发第一次，之后每 50 条一次（100、150……）；任何一次压缩（含压力触发）都会重置轮数时钟。到达条数后的第一个空闲点触发（阈值之下也压）。`0` 关闭；需保持 `auto: true`（默认开） |
| 手动 | `/dcp compact`、`/compact` | 随时可用 |

- **subagent 同样生效**：进程内 subagent（含 continuable 与 one-shot 子代理）走同一套事件分发，压力/溢出/轮数触发对子会话独立计数、独立触发。轮数触发按 assistant message 计数，所以全程只有 1 个 turn 的 one-shot 子代理（多次工具迭代）也能触发。
- **压缩可见性**：每次压缩成功后，会话里追加一行 `dcp: 已压缩 N 条历史（约 X tokens，触发方式）` 通知行（前端渲染为折叠行）。注意该行也会作为上下文随请求发给模型（每次压缩约 15–25 tokens），且 **0.4.0 起默认开启**；`notice: false` 可关闭。`/dcp` 的 stats 持续累计（压力触发的多次 region 提交各计一次）。

## 配置

全部可选，默认即用：

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholdRatio` | 0.8 | 压力触发阈值（继承上游 compaction-basic 默认 0.8；本插件 bundle patch 挂载时默认 0.7，中文场景建议 0.7） |
| `roundInterval` | 50 | 每 N 条 assistant message（一次 LLM 往返）触发一次压缩（0 关闭）。默认 50：50、100、150……每次压缩后重数 |
| `notice` | `true` | 压缩后在会话中追加一行通知 |
| `language` | `zh` | 摘要语言；`zh` 额外识别中文报错和"待办：" |
| `tokenEstimate` | `cjk` | CJK（中/日/韩/全角）按 ~2 字符/token 计价；`ascii` 与宿主一致 |
| `dedup` | `true` | 标注重复工具调用 |
| `purgeErrors` | `true` | 旧报错折叠成一条提示 |
| `maxItems` / `maxItemChars` | 10 / 200 | 摘要密度 |
| `maxSummaryTokens` | 2048 | 摘要 token 预算 |

> **升级提示（0.5.0）**：`roundInterval` 的计数单位由 completed turn 改为 assistant message——同值下触发会更频繁（一个 turn 内往往有多条 assistant message）。

## 设计参考

- [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- dsh 官方 compaction 接口：`docs/subsystems/compaction.md`（deepseek-harness）

## 开发

```bash
npm install && npm test     # 65 个用例：抽取/压缩/命令/配置/触发/安装脚本
```

## License

MIT
