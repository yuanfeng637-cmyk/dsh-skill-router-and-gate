# Changelog

本文件按版本记录**可观察的行为变化**。详细设计文档见 `docs/`。

## v0.5.0 (2026-10-19) — 轻量化

- 资源索引按"技能名 + 描述"签名缓存 **10 分钟**；此前每一步都会重建（读取 90+ 个 `SKILL.md`）。
- 判定层熔断：同一会话**连续 2 次判定超时**后 **5 分钟**内不再调用 LLM 判定，改用词法兜底；成功一次即清零。trace 记 `judge-timeout-banned`。
- 已知取舍：只改 `SKILL.md` 正文、名字与描述不变时，索引最长 10 分钟陈旧。
- 文档：`docs/RELIABILITY-v33.md`。

## v0.4.0 (2026-10-18) — 回答闸改为显式开启

- `answerGateMode()` 只认显式 `warn` / `block`；未设置、空串、`0`、`off`、未知值一律 **off**。
- off 时不注入每轮合同说明、不包装 `llm/stream`、不改正文。此前默认 block，会介入实际回复。
- 测试改为显式设置 `DSH_ANSWER_GATE=block` 再断言 block 语义；模式解析用例断言"未知值 ⇒ off"。
- 文档：`docs/RELIABILITY-v32.md`。

## v0.3.0 (2026-10-18) — 稳定性硬化

- 回答闸自身降级（`stream-limit`：超时、字节/分块上限）不再写入正文，只留审计与 trace。
- R4 读取证据改为**会话级**（键含内容 sha256）：不再因"开了新一轮"要求重读同一文件；内容变化仍失效。
- R8 豁免理由增加 `irrelevant`；拒绝文案按策略中实际允许的理由动态渲染。
- 合规策略解析失败时回退 **last-good** 并记 `policy-stale` 审计；无 last-good 才拒绝，且提示写明原因与路径。策略缓存按 `mtime:size` 失效。
- 技能目录快照失败退化为"不路由"，不再让 `preStep` 失败。
- 文档：`docs/RELIABILITY-v31.md`。

## v0.2.0 / v0.1.x — 早期版本

- v30：回答闸不再在工具调用后追加文本（消息协议错误）；告警即时流式输出；证据索引有界；重复指令按会话去重。见 `docs/RELIABILITY-v30.md`。
- v26：通用本地技能／子资源索引与路由驱动阅读门控；IDF／字段长度归一化与分差弃权。见 `docs/GENERIC-ROUTING.md`。
- 更早的设计说明集中在 `docs/DESIGN.md`、`docs/ANSWER-GATE-v27.md`、`docs/ANSWER-GATE-v28.md`。

## 版本规则

- `VERSION` 常量（`lib/index.js`）是运行日志里唯一能自报版本的字段，必须与 `package.json` 的 `version` 同步递增。
- 每次行为变化都写一节 `docs/RELIABILITY-vNN.md`，并在 README 顶部列出当前版本与历史入口。

<!--
CLAIM: 本 changelog 的 v0.3.0/v0.4.0/v0.5.0 条目与对应 docs/RELIABILITY-v31/v32/v33.md 及提交 a3eeee5/40fb875/aa9f2a7 一致
COUNTER: v0.2.0/v0.1.x 段只列了两个代表版本，早期更细的改动未逐条收录
CHECK: 对照三份 RELIABILITY 文档与 git log
VERDICT: 已验
-->
