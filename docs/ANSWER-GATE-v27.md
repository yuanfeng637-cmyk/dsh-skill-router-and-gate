# 回答层硬闸可行性与实现（v27）

> 历史实现记录：当前仓库行为已由 [v28 分级回答闸](ANSWER-GATE-v28.md) 替代。下文的三轮窗口、工具调用取消和超限拒绝等说明仅描述 v27。

评估日期：2026-10-17。范围：本仓库源码、测试与文档；宿主只读。

## 决定性结论

本机安装的 DSH desktop runtime（包内版本 0.2.0-rc.2）允许在回答文本发布前拦截。可用入口是 llm/stream waterfall；不是 agent/assistant-stream 通知。

归档物理路径：C:/Users/19818/AppData/Local/Programs/DeepSeek Harness/resources/app.asar。
以下文件路径均是归档内路径，行号按其 UTF-8 源文件计算；不要求 app.asar 是普通目录。

| 文件（app.asar 内） | 行号 | 依据 |
| --- | --- | --- |
| dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js | 606–609 | llm/stream 元数据明确标为 waterfall，next 返回 AsyncIterable<StreamChunk>，允许自己 yield chunks 来 short-circuit；请求冻结，只读 |
| dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js | 2370–2371 | streamWithRegistration 调用 ctx.waterfall(this, 'llm/stream', options, adapterStream) |
| dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js | 1072–1078 | 先取得上述 stream，然后逐个 chunk 调用 live.push |
| dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js | 395–409、1067–1068 | live.push 后才发布 agent/assistant-stream 的 chunk frame |
| dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js | 1262–1276 | 请求带 deriveMessages 的历史、sessionId；经 markAgentLoopRequest 标记并冻结 |
| dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js | 372–387、2390 | 标记使用 WeakSet，导出 isAgentLoopRequest 与 BlockAssembler |
| dsh/node_modules/@deepseek-ai/dsh-llm/lib/invariant.js | 61–66 | 宿主自己的流校验器按 global:true、prepend:true 注册，插件沿用这个方式 |
| dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js | 902–918 | pre-step.messages 只是当前 claimed 消息，不是上一轮回答全文 |
| dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js | 248–262 | emit 通知不使用 listener 返回值，异常仅记日志，不能把 observer 当硬闸 |

所以：在本机已核验版本可以实时拦（发布前），但必须缓冲完整生成后检查，不能同时保证逐 token 展示。没有一个可直接返回“拒绝最终回答”的 agent-final waterfall；这里使用更早的模型输出流扩展点。

## 已实现行为

lib/index.js 的 VERSION 从 26 递增为 27（第 77 行）。package.json 的包版本仍沿用仓库原有 0.2.0，未做发布。

| 文件/位置 | 函数或 hook | 行为 |
| --- | --- | --- |
| lib/answergate.js:11 | numbersOf | 完整数值 token 提取，保留原文位置；支持有符号数、小数、千分位、科学计数、全角与 Arabic-script 数字 |
| lib/answergate.js:27 | collectAnswerEvidence | 仅从请求里的 tool-role 文本找数字；用户、assistant 自写内容及工具参数不提供数字证据；最近 N 用户轮，默认含当前轮共 3 轮 |
| lib/answergate.js:54 | checkAnswer | 逐段执行数字、分母、不可用证据检查；返回违规位置与工具调用出处 |
| lib/answergate.js:82 | answerGateNotice | 生成固定拦截提示，不向用户泄露被拒原文 |
| lib/answergate.js:90 | guardAnswerStream | 缓冲、检查、放行或替换；同时校验 live delta 和最终 assembled text；违规时丢弃原文、推理、工具调用与 replay 元数据；保留 usage |
| lib/index.js:1137 | agent/pre-step | 即使技能目录为空，也给真实用户/goal 轮注入机器语法说明；提示只是辅助，硬闸独立执行 |
| lib/index.js:1149 | llm/stream（global + prepend） | 仅接管 isAgentLoopRequest 为真的模型请求，不处理 judge、compaction 或其他手工 LLM 调用 |
| lib/index.js:1050 | /skill-gate status | 展示 answerGate=before-publish/off 与 VERSION |
| package.json | scripts.check | 纳入新增模块语法检查 |
| _test/stubs/dsh-llm/index.mjs | 测试桩 | 增加请求归属标记及 assembler 子集，供离线 hooks 集成测试 |

不新增会话缓存或额外审计路径。证据随每次请求读取，避免跨会话共享状态。trace 沿用既有实现：stage=answer-gate，带 session、ok、issues、matches；matches 包含工具调用 ID。trace 仍是既有的异步 best-effort 写入，关闭/写入失败不影响内存中的硬闸判断，不应把它当可靠持久化数据库。

## 三条规则的机器语义

1. 数字出处是数值 token 出现在工具输出。千分位可归一化，但不自动证明单位换算或算术推导；例如等值的不同科学计数写法可能被保守拒绝。无出处数字须直接写成 [未验]116；标记只覆盖紧邻的一个数。默认窗口含当前轮共 3 轮；DSH_ANSWER_GATE_RECENT_TURNS 仅接受有效正整数，上限 20，否则回退 3。压缩后已离开请求的工具证据不再可用。
2. 全部、所有、一致、every、all（英语按词边界、忽略大小写）触发分母闸。空行分隔段落；同段须有整数分母=N（也支持全角等号）或 N 列/N 条/N 链，并在工具输出中命中该 N。[未验] 不豁免分母规则；另一个段落的分母不解锁当前段。
3. 没有、不支持、不可用、无此接口，以及部分对应英语短语触发不可用闸。只认本轮 tool message.isError===true，并能关联到真实 assistant tool-call 的失败。至少两条不同“工具名 + command/cmd/file_path/filePath/path”（其他参数按稳定 JSON）的方法签名；重复失败不累计。每条都须在同段写 [失败证据:toolCallId]，并附该方法字符串和输出首个非空行的原文前缀（最多 160 字符）。只写引用、伪造引用、写“试过了”或引用上一轮失败均不放行。isError=false 的输出即使含 failed 字样也不当成失败，避免靠正文猜状态。

示例（只有真实记录存在时才放行）：

> 接口不可用；read /a：ENOENT path missing [失败证据:a]；shell test-path /b：Access denied [失败证据:b]

## 发布时机与失败行为

在任一原始 chunk 交给 Agent 前，等待上游生成结束及校验完成。通过后按原顺序释放原始 chunks。违规时整次候选替换为 [回答闸拦截]，不自动重试、不自动调用工具，也不执行被拒生成里的工具调用。模型失败/aborted 的 finish 保留其恢复语义，但半截候选与 replay 不释放。抛异常、取消、超出默认 8 MiB 或 50000 chunks 的缓存上限时不放出已缓存候选。

开关：DSH_ANSWER_GATE=0 单独关闭；已有 DSH_SKILL_GATE 总开关、运行时 /skill-gate off 及 kill switch 继续生效。无需 artifact policy。它们是管理员开关，不是模型写一个 SKIP 就能绕过的语法。

## 验证结果

所有统计为 Node test runner 的汇总项数量；judge.test.mjs 内部旧式断言不额外叠加计数。

| 阶段/命令 | 通过 | 失败 | 跳过 | 分母（tests） |
| --- | ---: | ---: | ---: | ---: |
| 改前 node --test | 83 | 0 | 12 | 95 |
| 改前 npm test（带 resolve-stub） | 95 | 0 | 0 | 95 |
| 改后 node --test | 99 | 0 | 16 | 115 |
| 改后 npm test（带 resolve-stub） | 115 | 0 | 0 | 115 |

npm run check：退出码 0，检查现有模块及新增 answergate.js。

新增 20 个测试汇总项：answergate.test.mjs 16 项，answerapply.test.mjs 4 项。包括 token 边界、逐数未验、真实用户轮窗口、同段分母、两种失败方法/真实引用、旧轮/成功/重复方法拒绝、首次 yield 时机、原始 chunks 保真、live/final 矛盾、工具调用取消、并发请求隔离、judge 隔离、开关、取消/异常/缓存限制/终止失败恢复。

原始日志：
- validation-v27-baseline.log：改前 npm test。
- validation-v27-tests.log：最终 npm test。
- validation-v27-node-test.log：最终 node --test。
- validation-v27-check.log：最终语法检查。

## 能力边界与未完成事项

- 源码接入与离线单测/hooks 集成测试已验证。没有在真实 DSH UI 中执行最终验收；本次不部署 profile，不执行 refresh.ps1，不重启 DSH，不改全局配置，不 push/publish。这里的“可实时拦”由本机宿主源码调用链与离线发布时机测试支持，不冒充已部署状态。
- 数字出现与语义支持不是一回事。工具输出碰巧包含同一个数也可能放行；工具把模型指定的数 echo 出来仍会成为输出。没有实现语义蕴含检查、单位/对象绑定、算术证明或防数据洗白。
- 数值解析器识别上述数字字符形式，不解析中文/英语数词或任意数学表达式。关键词检测可被改写绕开，也会误拦引用、代码示例或“没有改文件”等非能力陈述；这些文字没有自动豁免，以免新增填空式逃生口。
- 分母存在不证明逐项比较完成；两条失败不证明所有替代路径都失败，也不证明失败与能力断言的主题相同。用户背景中的答非所问、把推断写成事实等语义问题仍未由这三条词法规则解决。
- 最新宿主已核验 isAgentLoopRequest、BlockAssembler 导出。旧宿主未验证；缺这些导出可能在加载时失败。第三方若在本闸外层重新改写流，或另走非 loop-owned 输出路径，无法由本插件保证。真正宿主级不可绕过保证需要宿主统一的发布边界。
- 首 token 延后是发布前完整检查的必要代价；未做生产延迟/内存基准。缓冲上限保护内存，超限拒绝不会降级成泄漏候选。

## 宿主不支持流拦截时的最小替代

本机无需降级。若目标宿主只有 agent/assistant-stream 通知：只能在该通知中收集已发布的正文并排队违规结果，再在下一次 agent/pre-step 中注入警告（或以 pre-step reject 拒绝继续模型步骤），不能撤回、拦截或改写已发文本。pre-step.messages 本身不是历史全文，不能只扫它来假装已检查上一回答；必须有明确的会话历史读取 API 或通知监听累计。这个降级方案本次未实现，避免把事后提醒标成实时硬闸。

## 宿主文件指纹

- dsh/package.json — SHA256 09058d99b57edc509ba44f2e934094daf36a592fcef24b31793a250ba9dbb124
- dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js — SHA256 9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120
- dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js — SHA256 2f55bba215082d35da78c9bd1e9336582d60f29eb00c4b817f9c78725ad8c291
- dsh/node_modules/@deepseek-ai/dsh-llm/lib/invariant.js — SHA256 8cb78641252b7a41523fef2c571dd42c698de4c9475dd91683191cefa4dced48
- dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js — SHA256 00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2
- dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js — SHA256 7b9aa39474de83115cf890dd7f8904cf0d59df0811cb335ab85565a04f1aac93
