# dsh-skill-router-and-gate

v25：新增[通用本地技能／子资源索引与路由驱动阅读门控](docs/GENERIC-ROUTING.md)。无需新增任务或产物到参考文件的手工映射；配置仅含开关与阈值。更新后运行 `refresh.ps1` 并重启 DSH。

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
