# dsh-skill-router-and-gate

<!--
CLAIM: README 顶部版本说明改为 v33（轻量化），v32/v31/v30 降为历史条目
COUNTER: 正文其他处的"以 v32 为准"需同步改成 v33
CHECK: 全文 grep v32/v33 与 package.json、VERSION 常量核对
VERDICT: 已验
-->
当前源码与运行版本：**v33**。轻量化：资源索引按目录签名缓存 10 分钟（不再每步重建），判定层加熔断（同会话连续 2 次超时后 5 分钟只走词法兜底）。见 [v33 轻量化](docs/RELIABILITY-v33.md)。

v32：回答闸改为**显式开启**：未设 `DSH_ANSWER_GATE` 时完全不介入（不注入合同说明、不包装流、不改正文），只有显式 `warn`／`block` 才启用检查。见 [v32 回答闸改为显式开启](docs/RELIABILITY-v32.md)。

v31：硬化闸门自身稳定性：自身降级（超时/超限）不再写入正文；读取证据改为会话级；R8 增加 `irrelevant` 豁免；策略损坏回退 last-good；技能目录快照失败退化为不路由。见 [v31 稳定性与可靠性硬化](docs/RELIABILITY-v31.md)。

v30：修复回答闸在工具调用后追加文本导致的消息协议错误；告警即时流式输出，支持即时取消，证据索引有界，重复指令按会话去重。见 [v30 可靠性修复](docs/RELIABILITY-v30.md)。v27/v28 文档保留为历史记录，当前行为以 v33 为准。

v26：修复[通用本地技能／子资源索引与路由驱动阅读门控](docs/GENERIC-ROUTING.md)：恢复 SKILL.md 声明字段，采用 IDF／字段长度归一化、分项权重与分差弃权，并为无匹配参考的技能增加可执行的 SKILL.md 前置阅读。新增两种 catalog 模式的全量回归；原始 79 项不含 bundled office 技能的差异见文档。更新后运行 `refresh.ps1` 并重启 DSH。

**Three-layer skill control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a per-turn shortlist, a hard gate that makes it stick, and an opt-in policy that binds the exact managed commands.**

| Layer | What it does |
|---|---|
| **Router** | On every turn, one in-process LLM judge reads the live skill catalog and injects a ranked shortlist of the skills the task actually needs. A 9-way lexical scorer takes over if the judge times out, errors, or returns invalid output. |
| **Gate** | If a tool call needs a managed format (**xlsx / docx / pptx / pdf / csv-tsv**) and the matching skill was never loaded in this session, the call is **denied** — with an instruction to load the skill and re-send the same command. |
| **Policy** (opt-in) | With `DSH_SKILL_GATE_POLICY` pointing at a project-owned JSON file, managed commands are **registered by exact text**, bound to input/script hashes, and require same-session successful evidence within a 30-minute TTL. No LLM interpretation of prose: the policy is data, and the trace ledger records every decision. |

**Name vs. short handle.** The package and repository are `dsh-skill-router-and-gate`; the **slash command and
environment variables use the short handle `skill-gate`** (`/skill-gate`, `DSH_SKILL_GATE_*`). Same plugin.

## v0.2.0：可机检的依从约束（合规策略层）

加载成功现在写 `skill-loaded`，并同步路由账本的 `loaded`。它证明加载，不能证明技能全部得到遵守。
加载 `bioinformatics-toolkit` 后，首次直接执行裸命令 `mafft` / `iqtree` / `iqtree2` / `iqtree3`
前，须有同会话先前成功、被接受的独立 `--help` / `-h` 输出；有效期 30 分钟。
独立版本查询放行，但不计帮助证据。路径调用、复合 shell、SSH、脚本内部调用不在这个默认规则的覆盖面。

项目特有约束通过 `DSH_SKILL_GATE_POLICY=<策略 JSON 的绝对路径>` 显式开启；未设置时不猜项目标准。
完整策略格式和例子见 [设计记录末节](docs/DESIGN.md)。策略用 `protect` 字符串命中受管命令，
用 `actions[].command` 固定完整命令；用输入/脚本/引用 SHA256、用户裁定原文和来源 SHA256、
先前验证命令及实际输出片段建立前置条件。达到任一阈值（wall ≥300 秒 / CPU ≥1,800 秒 /
输出 ≥100 MiB / 请求 ≥100 次）须声明假设、至少一项已成功的便宜验证及中止条件。
四项是显式估计，不是插件对任意进程的预测或资源配额。

审计默认写 `~/.dsh/skill-gate-compliance.ndjson`，可用 `DSH_SKILL_GATE_COMPLIANCE_TRACE` 改路径。
前置审计写入失败就拒绝受管动作；结果审计失败不改变已执行事实，也不会解锁后续验证。
回执含实际文本片段、输入/脚本来源、输出文件 SHA256、生成时间与插件版本。
输出文件未更新或不存在时 `receiptComplete=false`；旧脚本/引用来源缺标注或超过24小时会记告警。
没有回复发布闸，因此日志不能保证模型在最终回复展示证据或禁止它说“完成”。
后台、远端、普通工具文本中的退出码，以及自然语言规则的科学含义仍需要执行端或人工核验。

策略应由用户审核和保管；插件不提供防止 agent 改写策略的安全隔离。错误/缺失的已配置策略会拒绝 shell 工具，
可通过 `/skill-gate off` 恢复；总开关及文件 kill switch 现在对全部执行闸生效。
新增依从闸没有“拒绝三次后放行”的退路；原格式加载闸仍保留原有 `skillGateMaxDeny` 行为。

## Why this exists

DSH injects the full skill catalog and expects the model to call the right skill by itself. In long sessions that
does not hold: the catalog is present from the first message, yet skills stay untouched for thousands of turns.
A shortlist helps, but a shortlist is only advice — so the second layer enforces it: the call that needed a skill
is refused until that skill is loaded.

## Install

```sh
# from a local checkout (verified)
dsh plugin --profile <profile> add "file:/abs/path/to/dsh-skill-router-and-gate"

# straight from this repository (verified: npm resolves the spec; the package manager clones it)
dsh plugin --profile <profile> add "github:yuanfeng637-cmyk/dsh-skill-router-and-gate"

# same thing over SSH, for networks where HTTPS to github.com is blocked:
dsh plugin --profile <profile> add "git+ssh://git@github.com/yuanfeng637-cmyk/dsh-skill-router-and-gate.git"
```

Then **restart DSH** — plugin code is not hot-reloaded.

- **Node** `^22.19.0 || >=24.0.0`
- **DSH**: `>=0.1.5-rc.1 <0.3.0-0` (as declared in `package.json`; developed and verified against **0.2.0-rc.2**)
- `@deepseek-ai/dsh`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-skill` are **optional peers** — the profile provides them.

## What you will see

1. **Shortlist** — a system reminder added to the turn, listing the candidate skills (name + why) and telling you
   to load one with the `skill` tool by its exact name. If none applies, ignore the list.
2. **Catalog fallback** — if DSH's native `<available_skills>` block is missing, this plugin supplies the catalog
   itself (and marks it as such).
3. **Gate refusal** — the tool call does not run; you get a message naming the skill to load. Re-send the same
   command after loading it.

## Commands

| Command | Effect |
|---|---|
| `/skill-gate status` | gate state, session ledger, per-skill deny counters, version |
| `/skill-gate on` / `/skill-gate off` | toggle at runtime |
| `/skill-gate eval <fixtures.json>` | run the routing fixtures in-process (no runtime pollution) |

## Configuration

Environment variables. Defaults in brackets; only the short handle is used.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_SKILL_GATE` | `true` | master switch |
| `DSH_SKILL_GATE_TOPK` | `3` | candidates to shortlist (also the judge's cap) |
| `DSH_SKILL_GATE_MIN_SCORE` | `0.75` | floor for the lexical fallback path only |
| `DSH_SKILL_GATE_INCLUDE_LOADED` | `false` | keep recommending skills already loaded this session |
| `DSH_SKILL_GATE_JUDGE` | `true` | use the LLM judge (disable to run lexical-only) |
| `DSH_SKILL_GATE_JUDGE_ROUTE` | *(session default model)* | `provider/model` for the judge call |
| `DSH_SKILL_GATE_JUDGE_TIMEOUT_MS` | `8000` | judge wall-clock cap; on timeout the lexical path decides |
| `DSH_SKILL_GATE_JUDGE_MAX_TOKENS` | `1200` | judge output budget — reasoning models burn a small budget before any JSON |
| `DSH_SKILL_GATE_CATALOG_DESC_MAX` | `200` | per-entry description truncation shown to the judge |
| `DSH_SKILL_GATE_CATALOG_FALLBACK` | `true` | inject the catalog when DSH's native block is absent |
| `DSH_SKILL_GATE_SUPPRESS_AFTER` | `2` | stop recommending a skill that was ignored this many times |
| `DSH_SKILL_GATE_SKILL_GATE` | `true` | enable the hard gate |
| `DSH_SKILL_GATE_SKILL_GATE_MAX_DENY` | `3` | after N refusals for the same skill, allow the call (anti-deadlock) |
| `DSH_SKILL_GATE_TRACE` | *(on)* | set `0` to stop writing the trace ledger |
| `DSH_SKILL_GATE_POLICY` | *(unset)* | **absolute path** to the project-owned compliance policy JSON; unset ⇒ no project standard is guessed |
| `DSH_SKILL_GATE_COMPLIANCE_TRACE` | `~/.dsh/skill-gate-compliance.ndjson` | where the compliance audit (evidence, receipts, denials) is appended |

## How it works

- **One Cordis row** on `agent/pre-step` (see `cordis.patch.yml`): no tools registered, no patching of existing
  rows, no state beyond its own ledger. Removing the bundle restores the previous behaviour.
- **Candidates** come from the session's live catalog snapshot; skills that cannot be model-invoked, and skills
  already loaded in this session, are filtered out. (A session ledger is needed because `agent/pre-step` only sees
  the messages claimed for that step.)
- **The judge** is a single in-process `llm.stream` call with its own context — deliberately **not** a subagent,
  because a sub-session would re-enter `agent/pre-step`.
- **The gate** lives on `tools/pre-execute`: it matches command text that parses a managed format by tool position
  and requires the matching skill to have been loaded; otherwise it returns `deny` with an actionable message.
  Loaded state **and the catalog snapshot** are tracked **per session (agent)** — different sessions can see
  different skill roots, so one session's catalog never decides another session's gate. A skill counts as loaded
  only after the `skill` tool call **succeeded and was accepted**; a failed (or later blocked) load does not unlock
  the gate. Per-session state is LRU-capped and dropped when the session ends.
- **Trace ledger**: `~/.dsh/skill-gate-trace.ndjson`, one JSON line per decision (routing, fallback, deny, skip).

## Troubleshooting

| Symptom | What to check |
|---|---|
| No shortlist appears | `/skill-gate status`; the catalog snapshot may be incomplete (`snapshot.complete === false`) or `DSH_SKILL_GATE=0` |
| A call was refused that you think is fine | the gate only fires for managed formats; load the named skill and re-send the same command, or set `DSH_SKILL_GATE_SKILL_GATE=0` |
| The gate refuses the same thing repeatedly | after `MAX_DENY` (default 3) refusals for one skill the call is allowed through — check the trace ledger to see why the load never landed |
| Code edits seem to have no effect | plugin code is not hot-reloaded: restart DSH. If you installed from a `file:` path, re-copy the changed files into the profile first |
| Judge never decides | check `DSH_SKILL_GATE_JUDGE_TIMEOUT_MS` / `..._MAX_TOKENS`; on failure the lexical fallback decides and the trace records `judge-*` |
| A registered command is refused with *"managed action is not bound to an exact command"* | the command text is not byte-identical to what the policy registered (or the policy was edited); re-send it **exactly**, or update the policy and `make_policy`-style regenerate it |
| A registered command is refused with *"missing same-session, same-policy, same-input prior evidence"* | the required earlier step did not run **in this session under the current policy digest**, expired (30-minute TTL), or one of the hash-pinned inputs changed on disk — re-run the prerequisite, or re-pin the inputs after the file legitimately changes |
| Policy JSON is broken or missing | shell tools are denied; fix the file, or use `/skill-gate off` to recover |

## Disable / uninstall

- **Runtime**: `/skill-gate off`, or create `~/.dsh/skill-gate.off`.
- **Permanent**: `dsh plugin --profile <profile> remove dsh-skill-router-and-gate`.

## Design notes, history, measurements

`docs/DESIGN.md` holds the decision log: why the judge replaced pure retrieval, how the thresholds were chosen,
what was measured on a live host, and the bugs found on the way (**Chinese**). Read it before changing scoring,
the judge, or the gate rules.

## License

MIT — see [LICENSE](LICENSE).

## 中文速览

**做什么**：给 DSH 补三层技能控制 ——
① **候选**：每轮由一次独立模型判定，读实时技能目录，注入排好序的候选（判定失败则退回 9 路词法打分）；
② **硬闸**：工具调用要解析受管格式（xlsx / docx / pptx / pdf / csv-tsv）而对应技能**本会话从未加载**时，
直接 **deny**，并告诉你先加载哪个技能；
③ **合规策略（可选）**：设 `DSH_SKILL_GATE_POLICY=<策略 JSON 绝对路径>` 后，受管命令按**精确命令文本**登记、
按**输入/脚本哈希**绑定，并要求**同会话、同策略摘要、同输入**的先前成功证据（有效期 30 分钟）。
策略是数据、不做自然语言解释；每次判定都写审计账本。

**装**：`dsh plugin --profile <配置名> add "file:<本目录绝对路径>"` → **重启 DSH**（插件代码不热重载）。

**用**：`/skill-gate status` 看状态与账本；`/skill-gate on|off` 即时开关；
`/skill-gate eval <fixtures.json>` 跑离线标定。

**配**：环境变量前缀 `DSH_SKILL_GATE_*`（各项默认值见上表）。总开关 `DSH_SKILL_GATE=0`；
只关闸、保留候选：`DSH_SKILL_GATE_SKILL_GATE=0`。

**排错**：没出现候选 → 看 `/skill-gate status` 与追踪账本 `~/.dsh/skill-gate-trace.ndjson`；
被闸拦 → 按提示加载技能后**原样重发**同一条命令；同一技能被拦满 3 次会自动放行（`DSH_SKILL_GATE_SKILL_GATE_MAX_DENY`）；
改了代码没生效 → 插件不热重载，**重启 DSH**；用 `file:` 安装的还要先把改动拷进 profile。

**设计取舍、阈值依据与全部实测记录**（中文）：见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## Development

Runtime v24 adds deterministic academic-writing routing. Explicit Chinese requests such as
`写材料方法`, `写材料与方法`, `写论文` and English requests such as `write the Methods section`
select `scientific-writing` when it exists in the current invocable catalog. This rule survives
judge `none`/`unsure`/failure and repeated-recommendation suppression. Confirmed loads and the
existing master switch still apply. The injection names `references/imrad_structure.md`, resolved
relative to the loaded skill's `SKILL.md` directory, and directs a full read without offset/limit.

Policy schema `version: 1` now also supports optional `artifact.specs[].requireReads`:

```json
{
  "paths": ["**/METHODS*.md", "**/MATERIALS*.md", "**/材料方法*.md"],
  "genre": ["methods", "methods-prose", "材料方法"],
  "requireReads": ["C:/Users/19818/.dsh/skills/scientific-writing/references/imrad_structure.md"]
}
```

Paths are case-insensitive project-relative globs; `**/` includes the project root. Every matching
spec contributes its prerequisites in addition to global `artifact.requireReads`. Reference paths
can be absolute or relative to project cwd. R4 covers write/create_file/edit targets, shell targets
recognized by the existing R7 scanner, and exact registered action outputs. The global R4 scope
remains write tools and registered actions. Evidence is still per-turn `absolute-path#sha256`:
partial/failed/blocked reads do not count, and content changes invalidate it. Missing reference
files and internal exceptions retain the existing fail-open behavior. Arbitrary script-internal
writes remain outside the plugin's observable scope.

```sh
npm test     # node --test, with a stub for @deepseek-ai/dsh-llm (that package only exists inside the host)
npm run check
```

The test suite runs **outside** DSH: `_test/resolve-stub.mjs` redirects `@deepseek-ai/dsh-llm`
(a host-only package) to a minimal stub in `_test/stubs/`, so the apply-level gate tests can run in any checkout.
Plugins loaded by the host still use the real package. Run the suite from a checkout, not from an installed profile copy.


## v28：分级回答闸

插件通过 `llm/stream` waterfall 检查 loop-owned 回答。默认 `block` 只拦截明确的计数、全称比较或整体能力否定等缺证据断言；孤立数字、普通“一致/全部”和局部“该接口不可用”降为告警，正文保留，末尾追加逐项 `[回答闸]` 提示。工具调用保持原有块与结束原因，继续接受其他工具闸检查。

- 数字证据覆盖请求内全部工具历史，以及本插件已观察到的同会话工具结果，默认保留最近 1000 条。代码、行内代码、路径、日期和版本常量单独豁免；无出处数字仍可紧邻标 `[未验]`。
- 分母支持 `分母=N`、`(分母: N 列)`、`N 条/链/项`、`N/N 相同`、`共 N 项中的 M 项`，可位于当前段或紧邻上一段。
- 不可用证据接受本轮真实失败的“工具名 + 命令或路径 + 失败输出首行”，`[失败证据:toolCallId]` 可选。局部否定需一条失败方法；整体能力否定需两种不同方法。“没有改文件”不触发能力检查。

`DSH_ANSWER_GATE=block|warn|off` 选择模式（默认 block，兼容旧值 0）。`DSH_ANSWER_GATE_MAX_RESULTS` 配置证据条数，上限 10000；旧 `RECENT_TURNS` 不再生效。`DSH_ANSWER_GATE_TIMEOUT_MS` 配置缓存期限，默认 2000ms，上限 60000ms；默认缓存上限 1 MiB / 10000 chunks。超时或超长即释放缓存、继续逐块输出，并在末尾提示检查未完成。真实用户消息明确说“本次免检”或“不用闸”可每会话豁免一个模型请求。总开关、kill switch 和其他工具闸仍生效。审计沿用 trace，不等待审计写入；`/skill-gate status` 展示模式及 VERSION。

本次只修改仓库，未同步 profile、未重启宿主。当前行为、验证记录与能力边界见 [ANSWER-GATE-v28.md](docs/ANSWER-GATE-v28.md)；[v27 文档](docs/ANSWER-GATE-v27.md) 保留宿主源码依据和历史实现记录。
