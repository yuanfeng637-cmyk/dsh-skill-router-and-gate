# dsh-skill-router-and-gate

**Two-layer skill control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a per-turn shortlist, and a hard gate that makes it stick.**

| Layer | What it does |
|---|---|
| **Router** | On every turn, one in-process LLM judge reads the live skill catalog and injects a ranked shortlist of the skills the task actually needs. A 9-way lexical scorer takes over if the judge times out, errors, or returns invalid output. |
| **Gate** | If a tool call needs a managed format (**xlsx / docx / pptx / pdf / csv-tsv**) and the matching skill was never loaded in this session, the call is **denied** — with an instruction to load the skill and re-send the same command. |

**Name vs. short handle.** The package and repository are `dsh-skill-router-and-gate`; the **slash command and
environment variables use the short handle `skill-gate`** (`/skill-gate`, `DSH_SKILL_GATE_*`). Same plugin.

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
- **Trace ledger**: `~/.dsh/skill-gate-trace.ndjson`, one JSON line per decision (routing, fallback, deny, skip).

## Troubleshooting

| Symptom | What to check |
|---|---|
| No shortlist appears | `/skill-gate status`; the catalog snapshot may be incomplete (`snapshot.complete === false`) or `DSH_SKILL_GATE=0` |
| A call was refused that you think is fine | the gate only fires for managed formats; load the named skill and re-send the same command, or set `DSH_SKILL_GATE_SKILL_GATE=0` |
| The gate refuses the same thing repeatedly | after `MAX_DENY` (default 3) refusals for one skill the call is allowed through — check the trace ledger to see why the load never landed |
| Code edits seem to have no effect | plugin code is not hot-reloaded: restart DSH. If you installed from a `file:` path, re-copy the changed files into the profile first |
| Judge never decides | check `DSH_SKILL_GATE_JUDGE_TIMEOUT_MS` / `..._MAX_TOKENS`; on failure the lexical fallback decides and the trace records `judge-*` |

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

**做什么**：给 DSH 补两层技能控制 ——
① **候选**：每轮由一次独立模型判定，读实时技能目录，注入排好序的候选（判定失败则退回 9 路词法打分）；
② **硬闸**：工具调用要解析受管格式（xlsx / docx / pptx / pdf / csv-tsv）而对应技能**本会话从未加载**时，
直接 **deny**，并告诉你先加载哪个技能。

**装**：`dsh plugin --profile <配置名> add "file:<本目录绝对路径>"` → **重启 DSH**（插件代码不热重载）。

**用**：`/skill-gate status` 看状态与账本；`/skill-gate on|off` 即时开关；
`/skill-gate eval <fixtures.json>` 跑离线标定。

**配**：环境变量前缀 `DSH_SKILL_GATE_*`（各项默认值见上表）。总开关 `DSH_SKILL_GATE=0`；
只关闸、保留候选：`DSH_SKILL_GATE_SKILL_GATE=0`。

**排错**：没出现候选 → 看 `/skill-gate status` 与追踪账本 `~/.dsh/skill-gate-trace.ndjson`；
被闸拦 → 按提示加载技能后**原样重发**同一条命令；同一技能被拦满 3 次会自动放行（`DSH_SKILL_GATE_SKILL_GATE_MAX_DENY`）；
改了代码没生效 → 插件不热重载，**重启 DSH**；用 `file:` 安装的还要先把改动拷进 profile。

**设计取舍、阈值依据与全部实测记录**（中文）：见 [`docs/DESIGN.md`](docs/DESIGN.md)。
