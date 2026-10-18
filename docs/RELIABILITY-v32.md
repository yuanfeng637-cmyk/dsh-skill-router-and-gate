# v32 回答闸改为显式开启

本版是对回答闸的**行为级大修**：它在 v31 之前默认处于最严的 block 模式，会把机器生成的提示拼进正文、并在每轮入口注入一段合同说明。用户的实际反馈是"插件影响到实际回复了，不只是思维链"，因此本版把回答闸改成**必须显式打开**的检查器。

## 默认关闭

`answerGateMode()` 现在只认显式的 `warn` / `block`（大小写不敏感），其它任何取值——包括未设置、空串、`0`、`off`、无法识别的字符串——一律按 **off** 处理。dsh 启动时若没有 `DSH_ANSWER_GATE` 环境变量，回答闸完全不介入：

- 不注入每轮合同说明（`source.kind === "answer-gate"` 的消息不再产生）；
- 不包装 `llm/stream`，不检查正文里的数字、分母、不可用结论；
- 不做任何正文替换。

v31 及更早的行为是"未设置即 block"，与用户预期相反；本版把默认值改掉，并保留显式 `warn` / `block` 供需要时使用。

## 显式开启后的行为

- `warn`：检查照旧，问题以提示形式追加在正文末尾；不替换正文。
- `block`：检查照旧，硬事实缺证据时替换对应文本块（保留工具块），其余同 `warn`；
- 两种模式下，`stream-limit`（超时、字节/分块上限）都只在审计与 trace 留痕，不写正文（v31 起的行为）。
- 会话级 `answerState.remind()` 仍在开启时生效，但只在显式模式下注入一次。

## 测试调整

回答闸相关用例现在**显式**设置 `process.env.DSH_ANSWER_GATE = "block"`，让既有断言继续验证 block 语义；模式解析用例改为断言"未知值按 off"。全量结果：**145/145 通过**。

## 迁移须知

- 若此前依赖"未设置即 block"，升级后需要显式 `set DSH_ANSWER_GATE=block`（或 `warn`）。
- 升级需重启宿主才能生效；运行中的进程仍持有旧模块。
- 版本：`VERSION = 32`，`package.json = 0.4.0`。

<!--
CLAIM: 默认 off、显式 warn/block、未知值 off，且 145/145 测试通过
COUNTER: 运行中的宿主仍加载 v31，必须重启后才体现默认 off
CHECK: node --test（bundle 与安装副本）、answerGateMode 单测、trace 中 source.kind=answer-gate 是否消失
VERDICT: 已验
-->
