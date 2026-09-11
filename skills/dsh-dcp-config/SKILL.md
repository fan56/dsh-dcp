---
name: dsh-dcp-config
description: "dsh 压缩引擎插件（@aiwayds/dsh-dcp）使用与配置指南。凡涉及上下文压缩、/dcp 命令、压缩调参（阈值/密度/语言/轮数触发/模型切换），或要配置 dcp 时先读本指南：裸 /dcp 即压缩、/dcp status 看状态与 /dcp set 十二个可调键、持久化到 cordis.patch.yml 挂载块 config: 段（dsh-dcp-setup 管理）、ask_user_question 调参向导、五类触发（压力/溢出/轮数/模型切换/手动）、subagent 会话独立计数生效。触发词：dcp、压缩、compaction、上下文超限、摘要、thresholdRatio、roundInterval、onModelSwitch。"
---

# dsh-dcp 使用指南（确定性上下文压缩）

> dsh 插件：替换官方 `compaction-basic` 的确定性压缩引擎——**零 LLM 调用**
> （去重 / 折错 / 密度控制），中文场景优先（CJK 计价、中文报错与"待办："识别），
> 附轮数触发。压力触发、保留尾巴、溢出恢复、tool-pairing 安全机制全部继承官方，只替换"摘要"这一环。

## 配置入口（两条路）

1. **会话内临时调参**：`/dcp set <键> <值>`，只影响当前会话，重启失效。十二个可调键：
   `dedup` `purgeErrors` `maxItems` `maxItemChars` `maxSummaryTokens` `language`
   `tokenEstimate` `thresholdRatio` `roundInterval` `notice` `onModelSwitch`
   `modelSwitchMinTokens`。
2. **持久化**：cordis.patch.yml 里 dsh-dcp 挂载块的 `config:` 段。用
   `npx dsh-dcp-setup` 写入并维护（带 marker 注释、改动前日期备份、幂等）；
   `--remove` 只删 setup 写的块，手工写的块不受影响。bundle 方式
   （`dsh plugin add @aiwayds/dsh-dcp` 或列在 profile `bundles`）自动挂载，无需手写 patch。

挂载块形状（`~/.dsh/cordis.patch.yml` 或某个 profile 的 cordis.patch.yml）：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- insert:
    - id: dsh-dcp
      name: '@aiwayds/dsh-dcp'
      config:
        thresholdRatio: 0.7   # 每个键都可选
        language: zh
```

## 配置键

dsh-dcp 自有键（除 `thresholdRatio` 外全部可用 `/dcp set` 调）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dedup` | `true` | 重复工具调用折叠成一条标注 |
| `purgeErrors` | `true` | 旧报错折叠成一条提示 |
| `maxItems` / `maxItemChars` | 10 / 200 | 摘要密度（条数 / 单条字符上限） |
| `maxSummaryTokens` | 2048 | 摘要 token 预算 |
| `language` | `en`（代码默认；bundle 挂载默认 `zh`） | 摘要语言；`zh` 额外识别中文报错和"待办：" |
| `tokenEstimate` | `cjk` | CJK（中/日/韩/全角）按 ~2 字符/token 计价；`ascii` 与宿主一致 |
| `protectedTools` | `['write', 'edit', 'apply_patch']` | 写侧工具（子串匹配）的重复调用不折叠进 dedup 标注 |
| `roundInterval` | 50 | 每 N 条 assistant message（一次 LLM 往返）触发一次压缩；`0` 关闭 |
| `notice` | `true` | 压缩后在会话追加一行通知 |
| `onModelSwitch` | `notice` | 模型切换后：`notice` 提醒执行 `/dcp compact`；`auto` 下一个空闲点自动压缩；`off` 关闭 |
| `modelSwitchMinTokens` | 32768 | 模型切换提醒/自动压缩的上下文下限（宿主 tokenMeter 实测）：不足则忽略该次切换；`0` 关闭此门 |

转发上游 compaction-basic 的策略键：`thresholdRatio`（上游默认 0.8；**本插件 bundle 挂载默认 0.7**，中文场景建议 0.7）、`retainRatio`、`retainTokens`、`maxTokens`、`summarizationProvider`、`summarizationModel`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`、`auto`。

## 交互式调参向导（ask_user_question）

用户抱怨压缩行为时，不要甩配置表让对方自己读——先用 `ask_user_question`
问清期望，再映射到键：

1. **触发时机**：更晚触发 → `thresholdRatio` 调高，或 `roundInterval` 调大
   （完全不想要轮数触发 → `roundInterval: 0`）；更早/更频繁 → 反向。
2. **摘要密度**：更细 → `maxItems` / `maxItemChars` 调大（预算不够再加
   `maxSummaryTokens`）；更省 → 调小。
3. **摘要语言** → `language: en|zh`。
4. **token 计价** → `tokenEstimate: cjk|ascii`。
5. **通知行** → `notice: on|off`。
6. **模型切换行为**：问用户切模型后想怎样——只提醒（默认 `notice`）/
   自动压缩（`auto`，省心但切换频繁时会多次重写历史）/ 不管（`off`）。

流程：先用 `/dcp set <键> <值>` 在会话内试效果，满意后再代写持久 config——
直接改 cordis.patch.yml 里 dsh-dcp 挂载块的 `config:` 段（setup 写的块可原位改，marker 保留）。

## 触发条件（五类）

| 触发 | 时机 | 说明 |
|---|---|---|
| 压力 | 每步请求前 | token ≥ `thresholdRatio` × 上下文窗口 |
| 溢出 | 模型报 context 超限 | 继承官方恢复流程 |
| 轮数 | 每累计 `roundInterval` 条 assistant message | 任何一次压缩（含压力/手动）都重置时钟；`0` 关闭；需保持 `auto: true`（默认开） |
| 模型切换 | 会话实际路由的 provider/model 变化 | `onModelSwitch` 控制（默认 `notice` 提醒）；`auto` 在下一个空闲点自动压缩；两道门：距上次压缩 <10 条消息、上下文 <`modelSwitchMinTokens` |
| 手动 | `/dcp`（无参数）、`/dcp compact`、`/compact` | 随时可用 |

- **subagent 同样生效**：进程内子代理（含 continuable 与 one-shot）走同一套事件分发，
  压力/溢出/轮数/模型切换对每个会话独立计数、独立触发。
- **两类通知行相互独立**：压缩通知行受 `notice` 管，模型切换提醒行受 `onModelSwitch` 管。
- `notice` 通知行本身也是上下文（每次压缩约 15–25 tokens）；`notice: false` 可关。

## 排障

1. `/dcp status` 看状态：当前配置、压缩次数、省下的 LLM 调用，以及
   per-session 概览（含子代理；已销毁的会话自动消失，列表最多前 10 个，超出显示 `+N more`）。
   手动压缩打裸 `/dcp`（或 `/dcp compact`）；命令用法打 `/dcp help`。
2. 会话压不动 → 先确认 `auto` 是否为 `true`（自动触发总开关，默认开），再看
   `thresholdRatio` 是否设得过高、`roundInterval` 是否为 `0`。
3. `npx dsh-dcp-setup --remove` 后出现 `WARN: a compaction-basic entry remains...` →
   patch 文件里还留着 disable 行，官方 LLM 压缩后端会保持关闭；不是给 dsh-dcp 用的
   就手动删掉那一行。
