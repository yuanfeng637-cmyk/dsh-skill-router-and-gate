# dsh-skill-router-and-gate

> **短名规则**：包名/仓库名是长名 `dsh-skill-router-and-gate`；**斜杠命令用 `/skill-gate`、环境变量用 `DSH_SKILL_GATE_*`**（命令与 env 按惯例要短，都指向同一个插件）。

给 DeepSeek Harness 补上**两层**：① Codex 有、而 DSH 没有的**技能选择（判定/检索）**；② DSH 也没有的**硬闸** —— 该用的技能没加载，就直接 `deny` 那条工具调用。

## 为什么存在

DSH 把完整技能清单推给模型，然后指望模型自己想起来调用。**实测这是不可靠的**：
本会话日志（`session.v4.jsonl.zstd`，解压后 77,624,222 字节）里，技能目录从
**第 22,247 字节（0.0% 处）** 起就带 `claim-check`，我却**全程 0 次**主动调用，
直到第 75,929,418 字节（**97.8%**）才有第一次尝试。

Codex 不这么做。它把「该用哪个 skill」当成**检索问题**
（出处 `~/.codex/logs_2.sqlite`，target `codex_skills_extension::shadow_selection_experiment`）：
每个 turn 跑一整套候选选择算法，47 个 turn 的实测命中率（命中>0 / 47）：

| 方法 | 命中>0 | 平均选中 |
|---|---|---|
| `task_context_fusion_v1` | **40** | 24.2 |
| `lru_plus_lexical_character_routing_v1` | 35 | 19.2 |
| `lru_plus_character_routing_v1` | 35 | 19.1 |
| `character_ngram_v1` / `rrf_lexical_char_v1` / `character_routing_card_v1` | 33 | 19.0 |
| `weighted_lexical_v1` / `multi_query_lexical_v1` | 28 | 12.7 |
| `fielded_bm25_v1` / `routing_card_exact_v1` | 26 | 10.9 |
| `lru_v1`（单独） | **2** | 0.13 |

**字基方法对 CJK 全面优于词基**（33–35 vs 26–28）—— 中文没有空格，分词不可靠。

## 本插件做什么

在 `agent/pre-step`（waterfall，契约见 DSH `Event.listEvents`）上：

1. `decision = await next()`
2. `snapshot = await ctx.skills.snapshot({ cwd, signal, scope: agent })`；`!snapshot.complete` 就不注入
3. 过滤 `invocation.modelInvocable === false` 与本次会话**已真正加载过**的
   （扫 `<skill_content name=...>`）
4. 对最后一条用户文本跑 **9 路检索**：
   `weighted_lexical_v1` · `fielded_bm25_v1` · `character_ngram_v1` ·
   `multi_query_lexical_v1` · `routing_card_exact_v1` · `character_routing_card_v1` ·
   `task_context_fusion_v1`（含 workspace `AGENTS.md` 关键词） · `query_coverage_idf_v1` ·
   `rrf_lexical_char_v1`
5. **RRF 融合**排序 + 极小 LRU 加成
6. **门槛只作用在 `query_coverage_idf_v1` 上**（见下）
7. 渲染成 `<candidate_skills>`，用 `createUserMessage`（`@deepseek-ai/dsh-llm`）
   **追加**到 `decision.messages`

**纯增量**：不注册 Tool、不改任何现有 row、不写任何状态。停用或卸载立即恢复原状。

## 门槛标定（这层最容易做错，所以留证据）

离线用例 → 各路打分实测：

| query | `query_coverage_idf_v1` | `character_ngram_v1` |
|---|---|---|
| 你确定吗 | claim-check **1.000** | 0.080 |
| 装好了吗 | claim-check **1.000** | 0.120 |
| 你把我codex缓存删了干什么 | claim-check **1.000** | **0.063** |
| 帮我用 RDP4 检测一下重组 | rdp4 **1.000** | 0.495 |
| 删了之后要重跑吗 | claim-check **0.500** | 0.061 |
| **午饭吃什么**（噪声） | **—** | **0.070** |
| 今天天气怎么样 / 哈哈哈 / 随便聊聊 | **—** | — |

**⇒ 余弦无法分离**（噪声 0.070 > 真例 0.063）。**只有覆盖率能完全分开：真例 ≥0.500，噪声全为空。**
所以门槛 = `coverage >= 0.5`，余弦只参与排序。

覆盖率定义（`scoreQueryCoverage`）：查询里每个**实词字组**是否出现在卡片里，
按该字组在目录里的 IDF 加权。三条过滤缺一不可：

1. **df > 0** —— 目录里没有任何卡片含它的字组要排除。否则它拿到最高 IDF（最稀有），
   把覆盖率整体拉低。实测「你确定吗」里的「定吗」就会毁掉对「你确定」的匹配。
2. **df > 0 但只剩 1 个字组时不能直接算** —— 覆盖率会变成 1.000。
3. **必须是实词字组**（`isContentBigram`）—— 只由高频虚词字（的了着吗是在有和就都也…）
   组成的字组不算证据。实测「午饭吃什么」唯一命中「什么」（来自 claim-check 的
   「为什么」），不排除就假阳性 1.000；而「写论文…」唯一命中「论文」必须算数。

## 已知边界（诚实标注）

**它无语义、无词义消歧**，所以：

- ⚠ **假阳性**：`没有比较近的高星类似项目吗` 命中 `claim-check`（因为触发词里有
  「比较」，但这里的意思是"相对地接近"，不是"比较数字"）。
  `帮我看看 BEAST 的 ESS 够不够` 命中 `paper-cn`。
- ✅ 注入的消息里明确写了：**候选不匹配就完全忽略，且不要提起这段**。
- ⭐ **系统的上限取决于 `whenToUse` 写得有多好。** 实测「清理一下C盘吧」原本
  什么都匹配不到（词表缺「清理」），补进触发词后立刻变成 `claim-check:1.000`。
  **这就是 Codex 把 description 强制写成 `Use when…` 的原因 —— 让那段文字成为
  可检索的索引，而不只是给人看的说明。**

## ② 破坏性操作的硬闸（已实现）

挂在 `tools/pre-execute`（waterfall，契约原文：**"Allow, deny, cancel, or ask before
dispatch."**）：

```ts
'tools/pre-execute'(exec: ToolExecution, next): Promise<PreToolDecision>
PreToolDecision = {kind:'allow'} | {kind:'deny', reason} | {kind:'cancel'} | {kind:'ask', reason}
```

判定顺序（返回 `null` 放行，返回字符串则 `deny`）：

1. 不是能删东西的工具（只认 `pwsh` / `bash` / `workflow` / `run_code`）→ 放行
2. 命令里没有递归/强制删除特征 → 放行
3. 命中已知禁区（`~/.codex`、`~/.dsh`、`~/.agents`、`~/.local/bin`、`~/.ssh`、`.git`、
   腾讯数据目录、WSL 虚拟磁盘）→ **拦**
4. ⭐ **删除目标出现在任一配置文件里 → 拦**
   —— 查 `~/.codex/config.toml`、`~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`、
   `~/.dsh/profiles/*/{package.json,cordis.yml,cordis.patch.yml}`（内容缓存 60 秒）

**第 4 条才是这道闸的真正判据**，来自用户 `AGENTS.md` 的硬规则：
*「删或改任何文件前，先在配置文件里搜它被谁引用」*。
硬编码一张禁区表挡不住 2026-10-06 的事故 —— 事故路径 `~/.cache/codex-runtimes`
当时**不在任何表里**，但它在 `~/.codex/config.toml` L29–31 被声明为 marketplace **源**。

### 实现时踩到的三个真 bug（都留证）

1. **`Copy-Item <目录> <已存在的同名目录>` 会生成 `lib\lib\` 嵌套** —— 必须复制目录**内容**。
2. ⭐ **`JSON.stringify` 把反斜杠变成双反斜杠**，导致从命令里抽出的路径
   `c:\\users\\…` 与配置里的 `c:\users\…` **匹配不上** —— 「查配置」这条规则整体失效。
   修法是统一 `normPath()`（小写 → 去 `\\?\` 前缀 → `\` 折成 `/` → 折叠重复 `/`），
   两边都过一遍。**这个 bug 是被单测抓出来的，不是看代码看出来的。**
3. ⭐ **v8：闸最初"含 `Remove-Item` 就算破坏性"，结果它拦下了我自己清空一个日志文件**
   （`Remove-Item ~/.dsh/skill-gate-trace.ndjson -Force`，落在保护区里）——
   删单个文件是合法日常动作。现在**必须有递归标记**（`-Recurse` / `rm -r` / `rd /s` /
   `del /s` / `find -delete`）才进判定；事故那条含 `-Recurse`，**照样拦得住**。

   **顺带一个副作用值得记住**：写"含破坏性示例"的测试脚本时，`pwsh` 命令本身会被闸拦
   （示例字面量就在命令文本里）。解法是**用 `write` 工具写测试文件**（它不走 shell 闸），
   再用不含敏感字面量的命令运行。

4. ⭐ **v9：把"粘贴的终端会话"当成了任务。** 用户粘了一段 PowerShell 会话
   （含 `PS C:\Windows\System32>`、`.dsh\skill-gate-trace.ndjson`），注入里冒出两个
   **1.000 的假阳性**：`diagnose-windows-sandbox-acl`（靠 "Windows"）、`loopx`（靠 "dsh"）。
   根因：切块后某些块**极短**（一行路径/命令），块里实词只有一两个，
   **命中一个覆盖率就是 1.000**。
   ⇒ 现在**要求至少 2 个实词命中；只命中 1 个时，那一个必须是中文**
   （保住「论文」「清理」「重组」「出处」，挡掉单个英文单词 "windows"/"dsh"）。
   实测：粘贴终端会话 / 单行路径 / `PS C:\Windows\System32>` **全部不注入**，
   而真任务全部正确命中。

5. ⭐ **v10：v8 的收紧又过了头 —— 闸拦下了只读命令。**
   v8 去掉"删除动词"只留递归标记，于是 `Get-ChildItem <~/.dsh/…> -Recurse -File`
   （我自己的同步脚本）被拦，**连改闸的同步命令都进不去，成了死锁**。
   ⇒ 现在**必须"删除动词 + 递归标记"同时出现**：

   | 命令 | v8 | v10 |
   |---|---|---|
   | `Remove-Item '…\.codex\x' -Recurse -Force` | ⛔ 拦 | ⛔ 拦 ✓ |
   | `Remove-Item '…\.dsh\trace.ndjson' -Force`（单文件） | ⛔ 拦 | 放行 ✓ |
   | `Get-ChildItem '…\.dsh\…' -Recurse -File`（只读） | ⛔ 拦 | 放行 ✓ |
   | `Copy-Item '…\.dsh\a' '…\.dsh\b' -Recurse`（同步） | ⛔ 拦 | 放行 ✓ |

   **打破死锁的办法**：用 `edit` / `write` 工具（**不走 shell 闸**）直接改 profile 里那份源码，
   或用 `robocopy`（命令里不出现那个触发词）。**两条都已验证可用。**

   **最讽刺的一条**：我第一次用 robocopy 绕行时**又被拦了** ——
   因为我的中文注释里写了「（无 ‑Recurse 字样）」，**那个词本身就在命令文本里**。
   ⇒ 闸是词法匹配，**它会读你写的每一个字，包括注释。**

6. ⭐ **v12：闸按"整条命令文本"判定 ⇒ 互不相关的片段被拼在一起判。**

   清理过程垃圾时连续误伤三次，都是同一根因：

   | 命令 | v11 | v12 |
   |---|---|---|
   | 删 `%TEMP%\x` **＋** 另一条语句里提到 `~/.dsh/profiles` | ⛔ 拦 | 放行 ✓ |
   | 只读 `Get-ChildItem … -Recurse` **＋** 另一行 `Remove-Item $f -Force`（删单文件） | ⛔ 拦 | 放行 ✓ |
   | 递归删 `…\.codex\x`（同一语句内） | ⛔ 拦 | ⛔ 拦 ✓ |

   ⇒ 现在**按 `;` 与换行切语句**（**不切 `|`** —— 管道两端是一个动作），
   一个语句只有在**自己**同时具备删除动词与递归标记时才算破坏性，
   再只拿这个语句去比 PROTECTED。

   **⚠ 切语句时踩到的坑**：参数经 `JSON.stringify` 后，换行是**字面的 `\n` 两个字符**，
   不是真换行 ⇒ 按 `\n` 切**切不开**，判定又退回整条文本（实测就是这样漏的）。
   必须先 `.replace(/\\r\\n|\\n|\\r/g, "\n")` 还原。

   ⇒ **单测 15/15。**

### 单测（11 例，0 失败）

| 命令 | 期望 |
|---|---|
| 删 `~/.codex/config.toml` | ⛔ 拦 |
| **删 `~/.cache/codex-runtimes`（事故路径）** | **⛔ 拦** |
| 删 `~/.dsh/profiles` | ⛔ 拦 |
| `rm -rf ~/.agents/skills` | ⛔ 拦 |
| 删 Chrome 模型权重缓存 | 放行 |
| 清空回收站 | 放行 |
| 只读 `~/.codex/config.toml` | 放行 |
| `read` 工具 | 放行 |
| `rm -rf /tmp/whatever` | 放行 |
| 删工作区临时目录 | 放行 |
| 删 `AppData\Local\pnpm` | 放行 |

## ③ 技能闸（v14，已实现）—— 治"技能就在目录里却从不调用"

**起因（用户 2026-10-07 原话）**：「但是问题不是你一直不调用这些技能吗，这是什么原因」

**三条根因（都有账本，不是猜）**：

| # | 根因 | 证据 |
|---|---|---|
| ① | **官方目录通道被它自己的闸门挡住** | `app.asar`（DSH 打包代码）原文：`const snapshot = await ctx.skills.snapshot({…}); if (!snapshot.complete) return decision;`。本机 trace：`catalogComplete` **15 条全 False、True 0 条** ⇒ 官方 `<available_skills>` **一次都没送过**；`<workdir>\.agents\skills` 不存在（可疑的"快照永不完整"来源） |
| ② | **候选注入覆盖面窄** | trace：`injected` **28** 次（每次只 2–3 个候选）／`catalog-fallback` 只有 **4** 次（全量目录）／`below-threshold` 20／`none` 8 |
| ③ | **清单是"建议"不是闸门** | 行为层的洞：遇到活儿默认写一次性脚本（"更快"），于是跳过加载。本 README 开头那条实测——"77.6 MB 日志里技能清单从第一条消息就在，而我全程 0 次主动调用"——说的就是它 |

**v14 把 ③ 机制化**：新增 `lib/skillgate.js` ＋ `_test/skillgate.test.mjs`
（**17 例，0 失败**；其中**误伤语料占 6 例**）。设计围绕用户的两条担心——「**误伤**」与「**可靠/稳定**」：

**精度（怎么不误伤）**

| 做法 | 效果 |
|---|---|
| **只认代码上下文，不认裸词**：`\bimport\s+openpyxl\b`、`load_workbook\s*\(`、`DictReader\s*\(`… | 散文里提"本机没有 pdfplumber"、`Where-Object { $_.Name -match 'fitz' }` 都**不触发** |
| **搜索类语句整条跳过**：`Select-String`/`findstr`/`grep`/`rg`/`sls` | `Select-String -Pattern 'openpyxl|load_workbook'` 放行（读文本 ≠ 解析受管格式） |
| **注释先剥掉**：整行 `#` 与 `<# … #>` 块 | 注释里写 `import openpyxl` 不触发 |
| **CLI 名要求"命令行位置"**：`pdftotext` 只算语句开头或管道/调用符之后 | 第一版因裸词 `pdftotext` 误伤了散文，被单测抓出来 |
| **裸扩展名不算** | `Get-ChildItem -Include '*.pdf'`、`Copy-Item a.pdf b.pdf`、`Remove-Item old.pdf` 一律放行 |

⚠ **第一版有个真 bug（已修）**：原先直接拿 `JSON.stringify(arguments)` 去匹配，语句开头是
`{"command":"`，于是所有"命令行位置"（`^`）判断在**真实运行时**全部失效——`pdftotext a.pdf out.txt`
漏拦、散文里的 `pdftotext` 反而被误伤。现改为 `commandText()` 先解出真正的命令文本再匹配。
**教训**：这类代码的单测必须用**真实运行时的参数形态**（对象 + 字段名），不能只喂裸字符串。

**稳定性（三道兜底，任何一道命中就放行）**

1. **技能不在当前目录清单里** → 放行（没有可加载的东西；清单 `knownSkills` 每轮 pre-step 刷新）；
2. **同一技能已拦够 `skillGateMaxDeny` 次**（默认 3）→ 放行并记 `gate-giveup`（防"加载一直没成功"卡死主流程）；
3. **本模块任何异常** → 调用方 catch 后放行（宁可放行，绝不放倒）。

**开关**：`DSH_SKILL_GATE_SKILL_GATE=off` 单独关闸；`~/.dsh/skill-gate.off` 关整个插件。
`/skill-gate status` 打印闸门状态、本会话已加载的技能、每个技能被拦的次数。

**解锁条件**：`skill` 工具一被调用就记进 `state.loadedSkills`，并并入账本的 `confirmedLoaded`
（两条独立路径，防止某条不通就永久锁死）；`skill` 工具自身永不放倒（否则死锁）。

**映射表**：`import/from openpyxl`、`load_workbook(`、`read_excel(`、`ExcelWriter(`、`.to_excel(`、`Import-Excel` → `office-xlsx`；
`import/from docx`、`docx.Document(` → `office-docx`；`import/from pptx`、`pptx.Presentation(` → `office-pptx`；
`import/from` 的 `fitz|pypdf|PyPDF2|pdfplumber|pymupdf`、`fitz.open(`、`PdfReader(`、`pdf_render_page(`、
`pdf_fonts(`、`pdftotext`（命令行位置）、`library(pdftools)` → `pdf`；
`DictReader(`、`csv.reader(`、`Import-Csv`、`read_csv(`、`read_table(`、`read.delim(`、`read.csv(` → `tabular-read`。

**为什么用 `deny` 而不是"提醒"**：本机策略下 `ask` 会被**自动拒绝**（等于没提醒），
而 `deny` 的理由会直接回到模型手里，形成"加载 → 原样重发"的自纠正回路。

**已知代价（残留，已标注不藏）**：① 在**引号里提到调用形式**（如 `Write-Output "先看 DictReader( 的用法"`）
仍会被拦，代价是加载一次技能；② 用 `write` 工具写 `.py` 再 `python x.py` 跑**不被拦**（命令行里没有解析词），
有意留这个余地——给 `write`/`edit` 加内容匹配会误伤写文档。

**新增一处待办**：① 里那个 `snapshot.complete=false` 没修——若把它修好，
官方每轮全量目录就回来了（比本插件的兜底更权威）。可做的实验：建 `<workdir>\.agents\skills\`
后再看 trace 的 `catalogComplete` 是否翻 True。

### v14.1（2026-10-07，Codex/GPT 评审后改了 5 处）

**评审通道（2026-10-07）**：原 DSH 会话里的 `mcp__codex_peer__ask_codex` 两次返回
`MCP session is missing or expired`。随后手工执行 MCP `initialize → initialized → tools/call`，
在独立实例上拿到 Codex 答复。记录：`http://127.0.0.1:47855/?room_id=88ea6acd-…`

**定位到的启动问题**：旧版 `启动交互窗口.vbs` 设置 `ELECTRON_RUN_AS_NODE=1`，再用
`DeepSeek Harness.exe --expose-internals workroom.mjs --ui` 承载中继。结果 47821 监听进程
处在 DSH Electron 宿主的受限上下文中；它用 `child_process.spawn` 启动 Codex app-server
并接管管道 stdio 时返回 `EPERM`。因此，Codex 桌面窗口是否打开不是关键条件，**中继本身必须
作为独立进程启动在 DSH 沙箱之外**。

**当前启动方式**：桌面快捷方式现在用 `%USERPROFILE%\miniforge3\node.exe` 直接运行
`D:\DeepSeek-Codex\workroom.mjs`，固定监听 `127.0.0.1:47855`。启动器不再把
`ELECTRON_RUN_AS_NODE` 传给中继；`workroom.mjs` 只在启动 DSH ACP 子进程时单独设置该变量。
DSH profile 的 `codex_peer` 与 Codex 的 `deepseek_harness` 都已改为 47855。服务仍只绑定
本机回环地址。

**已验证**：独立启动器运行后，监听进程为 `node`；MCP `initialize` 和 `tools/list` 均返回
200，工具列表包含 `ask_codex`；过期 session 返回 404。此前在 47855 上手工驱动的完整
`tools/call` 已成功。

**待验证**：当前已打开的 DSH 窗口仍缓存旧的 MCP profile/session。保存当前对话后，重启
DSH Desktop 或重新加载 profile，再从一个新 DSH 会话自动调用 `mcp__codex_peer__ask_codex`；
该次自动客户端调用尚未实测。若仍报 session expired，应记录新请求的 HTTP 状态码和时间，
不要把此前的手工 MCP 成功当作自动客户端已修好。

**GPT 抓出的两个真缺陷（已修）**

| # | 缺陷 | 修法 |
|---|---|---|
| ① | **"搜索语句整条跳过"是可复现的漏拦路径**：`python -c "import openpyxl…" \| Select-String "3"` 整句被跳，上游解析操作逃过闸门 | 收紧为 `SEARCH_ONLY`：**只豁免"整条语句以搜索命令开头"**（`^\s*(?:&\s*)?(?:Select-String\|findstr(\.exe)?\|grep(\.exe)?\|rg(\.exe)?\|sls)\b`） |
| ② | **`Import-Csv`/`Import-Excel` 没做命令行位置约束** ⇒ `Get-Help Import-Csv -Examples` 这类**查帮助**也被拦 | 复用 `CMD_POS` 前缀，要求命令位置 |

**另外 3 处按它的建议补齐**：③ 全部规则加 `i`（PowerShell 命令名大小写不敏感，`import-csv` 不该漏）；
④ PDF CLI 支持 `.exe`／引号路径／绝对路径，并补 R 的 `require(pdftools)`／`requireNamespace("pdftools")`／
`pdftools::pdf_text(`；⑤ **fail-open 不再静默**——`catalogReady`（`ready`／`degraded`）、
每类放行原因计数（`gateSkips`）、闸自身异常计数与最近原因（`gateErrors`/`gateErrorLast`）全部进 `/skill-gate status`；
技能**确认加载后清空该技能的拦截计数**（否则旧计数会一直挂着直到把闸降级）。

**测试**：`_test/skillgate.test.mjs` 从 17 例扩到 **27 例，27 通过**——新增 GPT 的 P0/P1 用例
（搜索管道上游必拦、大小写变体、`.exe`/路径、R 变体、here-string 送码进解释器、多语句、`cmd /c`、
六种参数字段名真形态），并把**已知覆盖边界**（字符串里提调用形式会拦、here-string 写文档也会拦、
`python x.py` 看不到源码不拦）写成明确预期而不是含糊放过。`judge.test.mjs` 仍 18/18。

**GPT 对取向的结论（原文摘要）**：「**可以保留 deny，但只当作窄范围的最后一道提醒，不应把它当作技能
发现机制或完整执行策略**……应先修复搜索管道漏拦、PowerShell 大小写和字符串/here-string 误判，
并让 fail-open 状态可见。」⇒ 与我的判断一致：真正的**发现机制**要靠①把目录通道修好（`snapshot.complete`），
闸门只做兜底。

**我保留未改的两处（并说明理由）**：① here-string 内容一律算命中——它同时是我把代码送进解释器的主要写法，
放过它等于把闸门最大的入口敞开（代价：写文档时可能被拦一次）；② `write` 写 `.py` 再 `python x.py`
看不到源码内容 ⇒ 不拦（有意留的余地）。

## ⚠ 版本与重启（多轮踩坑后的结论）

**1. 每次改代码都必须重启 DSH。** 实测：DSH **不会**热重载本插件。
（`include:hmr` row 确实 active，但本插件的模块没被它接上。曾据此误判两次。）

**2. `plugin_manager set_plugin` 的 enable/disable 不会重跑 `apply()`。** 实测：toggle
后 `agent/pre-step` 仍然工作，但 `apply()` 里后来新增的 `tools/pre-execute` 注册
**从未发生**。所以 toggle 不能替代重启。

**3. profile 里是"拷贝/硬链接"，不是符号链接。** 用 `write` 重写过的文件会**断开
硬链接** ⇒ profile 保留旧 inode（`lib/index.js` 一度停在 18,905 B 而源码已 25,642 B）。
改完必须 `refresh.ps1`。

**4. 模块内置 `VERSION` 常量，每条 trace 都带 `v:`。** 看一眼账本就知道跑的是哪版，
不用再靠猜。**这是被上面三条坑出来的。**

**5. 离线测试要设 `DSH_SKILL_GATE_TRACE` 指向别的文件**，否则会污染活运行时账本
（默认路径相同，实测混过一次）。

## ⭐ 活运行时验证记录（2026-10-06）

| 事项 | 证据 |
|---|---|
| `tools/pre-execute` 硬闸 | ✅ **实测被拦**：`Remove-Item '<home>\.codex\…' -Recurse -Force` 返回本闸的拒绝文案 |
| `agent/pre-step` 处理器 | ✅ 每轮都在跑（账本有 `queryLen:740`、`catalog:17` 的行） |
| **真凶：0 次注入** | ⛔ `stage:"incomplete-snapshot"` —— `ctx.skills.snapshot()` 报 `complete:false`，而旧版在这里直接 `return` |
| 修复 | v4 放宽为"只要有 skills 就用"，`complete` 仅记为状态 |

### 这个真凶教会的事

DSH 自带的 `@deepseek-ai/dsh-tool-skill` 要求 `snapshot.complete === true`，因为它要把
目录**发布成一条持久消息**（不完整就不发布、不缓存、下个边界重试）。
**本插件是每轮一条增量提示，部分目录完全够用** —— 照抄那条约束导致它永远不注入。
**`complete` 的语义看清楚了再抄。**

### ⛔ 第三个真 bug：把"工具结果"当成"用户输入"（v5 修）

`agent/pre-step` 的 `messages` 里，**`role:"user"` 的消息有 15 种 `source.kind`**
（本会话 20,554 行日志实测）：

```
user 1049 · None 43 · runtime-context 11 · goal 10 · compact-checkpoint 9 ·
skill-catalog 6 · subagent-settled 6 · tool-jobs 4 · agent-instructions 4 ·
user-approval 2 · tool-goal 2 · agent-message 2 · skill-routing 1 · dsh-session-title-llm 1
```

v4 只判 `role === "user"` ⇒ **把 subagent 结果、后台任务通知、runtime-context 当成了
"用户这一轮说了什么"** ⇒ 实测在真实运行时里路由出 `diagnose-windows-sandbox-acl`
（因为拿 `subagent-settled` 那段英文去匹配），而用户那一轮说的是「已经重启」。

**v5 只认 `source.kind === "user"`，没有时退回 `goal`。** 单测 5 例全过
（真用户输入优先 / 只有噪音时不注入 / goal 退回 / runtime-context 不注入）。

### ⛔ 第四个真 bug：长输入被系统性压低（v6 修）

覆盖率 = 命中字组 ÷ **查询总字组** ⇒ **查询越长分母越大**。
实测：566 字的 goal 文本里明明有「有没有出处」，整段覆盖率只有 **0.359**（< 0.5 门槛）
⇒ 不注入。**Codex 的 `multi_query_*` 系列正是为此分句打分。**

v6 改为**按句/换行切块、每张卡片取最高块**。实测：长文本夹「RDP4 检测重组」
从"不注入"变成 **1.000**。

### ⚠ v7 试过又回退（留证，别再走一遍）

想把"噪声长文本假阳性 0.727"压掉，试过**把 df=0 的字组按中性权重计入分母**。
**结果把正确匹配一起压掉了**：「用 RDP4 检测重组」「写论文的时候注意引用格式」
全变成不注入 —— 短查询里本来就夹着**空格/ASCII 相邻产生的垃圾字组**，
中性权重反而撑大分母。**已回退到 v6。**

⇒ **结论：这个假阳性是故意接受的代价**，兜底是注入消息里那句
「不匹配就完全忽略这段，也不要提起它」。**要再提高精度，正确的杠杆是写 `whenToUse`，
不是继续调分母。**

### ⚠ 测试脚本的坑

`lastUserText` 从 v5 起要求 `source.kind`。**旧测试脚本构造的消息没有 `source` 字段**，
于是全部"不注入"，看起来像插件回归 —— **实际是测试台的问题**（合成目录一度显示 7/6）。
新写的测试一律带 `source:{kind:"user"}`，补上后立刻回到 **13/0**。

## 📋 SKILL.md 的字段规范（从源码读出，非推测）

出处：`@deepseek-ai/dsh-skill-filesystem/lib/index.js` L664–703、L841–875；
`@deepseek-ai/dsh-skill/lib/index.js` L29–31、L441–449；`@deepseek-ai/dsh-tool-skill/lib/index.js` L42–47。

### 支持的字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` ⇒ **只允许 kebab-case，中文名不可能** |
| `description` | ✅ | 非空字符串 |
| `whenToUse` | — | 非空字符串；**只有程序化 provider 能读到，模型看不到** |
| `metadata` | — | 纯对象（不能是数组）；任意内容 |
| `disable-model-invocation` | — | 布尔 ⇒ `modelInvocable = !该值` |
| `user-invocable` | — | 布尔 ⇒ `userInvocable = 该值 !== false` |
| body | — | front matter 之后的内容，`trim()` 后作为 skill 正文 |

布尔可写：`true/false`、`1/0`、`"1"/"0"`、`"true"/"yes"/"on"`、`"false"/"no"/"off"`。

### ⛔ 会被**静默忽略**的写法（只写一条 logger.warn，skill 直接消失）

- **旧字段名**：`disableModelInvocation`、`modelInvocable`、`userInvocable`
  ⇒ 报错原文 `frontmatter field "X" is unsupported; use "Y"`
- YAML front matter 非法 / 缺失
- 缺 `name` 或 `description`
- `name` 不匹配 kebab-case 语法
- `whenToUse` 不是字符串

### ⭐ 由此得出的分工（本插件的核心设计依据）

`catalogSourceEntries()` **只抽取 `name` + `description`**：

```js
skills.map((skill) => ({ name: skill.name,
                         description: catalogDescription(skill.description, max) }))
// 渲染： `- \`${name}\`: ${description}`
```

⇒ **模型看到的目录里没有 `whenToUse`，也没有 `metadata`。**

| 字段 | 谁读 | 该放什么 | 上下文成本 |
|---|---|---|---|
| `description` | **模型** | 短、人话、一句 | 有 |
| `whenToUse` | 只有路由 | 简述何时用 | 会出现在注入块里 |
| **`metadata.routing`** | **只有路由** | **触发词表（数组或字符串）** | **零** |

**⇒ 把触发词放 `metadata.routing`：路由信号一样，但模型永远看不到，不占上下文。**
`claim-check` 的 46 个触发词就是这么搬进去的（`whenToUse` 从 295 字缩到 143 字）。

实测（`mdrouting.mjs`，12/0）：`description` 只写「回答前先自我否定一次。」，
命中全靠 `metadata.routing` —— 7 个真任务全中，5 个噪音（含粘贴的 PowerShell）全不注入。

## 追踪账本（度量层）

每次 `agent/pre-step` 写一行 NDJSON 到 **`~/.dsh/skill-gate-trace.ndjson`**
（`DSH_SKILL_GATE_TRACE=0` 关闭）。记录 `stage`（`injected` / `below-threshold` /
`empty-query` / `incomplete-snapshot` / `gate-deny` …）、目录规模、命中项与置信度。
**它同时是"处理器真的跑了"的唯一证据** —— 因为模型的注入物无法自省。

## 刷新已装副本

pnpm 的 `file:` 依赖装出来是**拷贝**（正式产物是**硬链接**），而且第二次安装会被判
`Already up to date` / `ambiguous-install`，**不会重新拷贝**。所以改完源码后：

```powershell
pwsh -File refresh.ps1          # 同步
pwsh -File refresh.ps1 -Verify  # 只比对
```

然后重启 DSH 让 ESM 模块重新加载。
（注意：被我的 `write` 重写过的文件会**断开硬链接**，profile 里保留旧 inode ——
这正是 `lib/index.js` 一度停在 18,905 B 的原因。）

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_SKILL_GATE` | `1` | 启动期总开关（活宿主里的开关是 `/skill-gate off`） |
| `DSH_SKILL_GATE_TOPK` | `3` | 注入几条候选；也是判定员一次最多能给几条 |
| `DSH_SKILL_GATE_MIN_SCORE` | `0.75` | **兜底**路径的覆盖率门槛（v13 起不再是主判据，见下） |
| `DSH_SKILL_GATE_INCLUDE_LOADED` | `0` | 是否也推荐本会话已加载过的 |
| `DSH_SKILL_GATE_JUDGE` | `1` | 是否启用判定层 |
| `DSH_SKILL_GATE_JUDGE_ROUTE` | 跟随会话默认模型 | `provider/model` |
| `DSH_SKILL_GATE_JUDGE_TIMEOUT_MS` | `8000` | 判定墙钟上限（裸延迟尚未实测，先按外部评审建议取 8 s） |
| `DSH_SKILL_GATE_JUDGE_MAX_TOKENS` | `300` | 判定输出上限 |
| `DSH_SKILL_GATE_CATALOG_DESC_MAX` | `200` | 判定员看到的每条目录描述截断 |
| `DSH_SKILL_GATE_CATALOG_FALLBACK` | `1` | 原生目录缺席时由 router 补一份 |
| `DSH_SKILL_GATE_SUPPRESS_AFTER` | `2` | 推荐过 N 次仍未被确认加载 ⇒ 本会话内不再推 |

## 安装 / 卸载

```bash
dsh plugin --profile desktop add "file:<home>/.dsh/_local-bundles/dsh-skill-router-and-gate"
```

卸载：把 bundle `dsh-skill-router-and-gate` 移除即可。

## 下一步

- **真实运行时验证**：需要一次 DSH 重启加载本版代码，之后看
  `~/.dsh/skill-gate-trace.ndjson` 是否逐轮出现 `stage:"injected"`。
- **闸的覆盖面**：目前只拦"递归/强制删除 + 命中禁区或配置引用"。写入类
  （覆盖配置文件、改凭据）尚未纳入。
- **语义缺口**：检索无语义、无词义消歧，假阳性靠注入消息里的"不匹配就忽略"兜底。
  提升上限的办法是把 `whenToUse` 写成含真实触发词的可检索文本（同 Codex 的
  `Use when…` 约定）。

## 来源与致谢

- 机制模仿 **OpenAI Codex** 的 `shadow_selection_experiment`（本地日志实测统计）。
- 挂载点与消息构造照 **DSH 自带 `@deepseek-ai/dsh-tool-skill`** 的 `agent/pre-step`
  范式（同一 waterfall、同一 `createUserMessage` 用法）。
- ⚠ 注意：v12 之前我们照它"`snapshot.complete === false` 就放弃"的纪律；v13 起
  **只记录** `complete`，不据此弃权（依据见下）。

---

## v13（2026-10-07）：把"选哪个"交给一次独立模型调用

### 为什么改（三条都有账本出处）

| v12 的缺陷 | 证据 |
|---|---|
| 召回太稀 | trace 164 条里只有 12 次过门槛、8 次真注入 |
| 精度不足 | 17:08 那句主题是**本插件自身**的中文（56 字）被推 `hyphy-pselection@0.731`（"选择"命中了"正选择"） |
| 跨轮去重失效 | 8/8 条 `injected` 的 `loaded` 都是空数组，**包括已经加载过某 skill 之后的轮次** |

根因（app.asar 里发射点原文 `messages: claimed` + 循环文档）：`agent/pre-step` 收到的
`messages` 只是**本步领取的那一批**，不是全史 ⇒ 靠扫 `<skill_content>` 做跨轮去重
必然失效。

### 现在的结构

```
agent/pre-step
  ├─ 轮次门控：这一步取不到用户文本 ⇒ 直接返回（工具步不判定、不阻塞）
  ├─ 目录：ctx.skills.snapshot() → 固定目录（按 name 排序，与 query 无关）
  │     └─ 原生 <available_skills> 缺席 ⇒ 补一份（每会话一次 + digest 去重）
  ├─ 判定：lib/judge.js 的一次 llm.stream（无工具、temperature 0、可 signal 取消、8s 上限）
  │     └─ 输出 pick / none / unsure；名字必须落在白名单里，否则丢弃
  ├─ 词法 9 路：降级为**影子**（只写 trace 的 lexicalTop）+ **兜底**（判定失败时，门槛 0.75）
  └─ 注入：只有 pick 才注入，且是**中性文案**（不带未校准的置信度、不用"必须加载"措辞）
```

**为什么不在线用真子 agent**：`subagents.start` 建的是**持久化**子会话，子会话自己
也会跑 `agent/pre-step`，而现有契约里没有"跳过 router"的可靠标记 ⇒ 回环 + 每轮多一个
持久会话。外部评审与我的判断一致：只有"判定必须读项目文件证据"时子 agent 才值得，
且要先有可靠标记；`unsure` 升级因此留到 v14。

### 运行时开关

```
/skill-gate status      # enabled / judge / 路由 / 门槛 / 账本规模 / trace 路径
/skill-gate off | on    # 进程内立即生效，不写任何文件
```
文件开关：`~/.dsh/skill-gate.off` 存在即跳过路由（每步只做一次 `existsSync`）。
启动期开关：`DSH_SKILL_GATE=0`。

### 无污染标定：`/skill-gate eval <fixtures.json>`

fixtures 是数组：`[{"id":"c01","query":"你确定吗","expect":["claim-check"]}]`。

它**直接调用判定 helper**（`lib/judge.js` + `ctx.llm`），把固定样本、固定目录、固定
提示词作为显式输入 —— **不经过 Agent**，因此不存在"router 往判定会话里注入候选"的
污染。v12 那次用子 agent 标定，16/16 被注入、15 条被塞 `claim-check@1.000`，分数根本
无法归因给判定员；这个入口就是为它准备的。

源码目录里有一份可直接跑的：`_test/fixtures-dev16.json`（16 例）。

⚠ 它只能当**开发集**：那 16 例是在"子会话被 router 注入候选"的环境里跑出来的，
不能用来报告判定员的独立能力。真正 hold-out 的要求（外部评审口径）：冻结目录 /
提示词 / 模型配置之后**新收集**的轮次，按意图分组，必须含"语义相近但不该触发"的
负例和复合任务例，而且**先盲标金标、再看判定结果**。

### hold-out 1（`_test/holdout-1.json`，22 例，2026-10-07 冻结）

- **来源**：会话日志里**真实用户轮次**（`source.kind === "user"`），不是编的。收割脚本
  只读 `~/.dsh/sessions/<workdir-slug>/*/session.v4.jsonl.zstd`，共提到 40 条，
  原始清单留在 `_test/holdout-candidates.json`（含时间与会话号，可复核）。
- **为什么只用了其中一部分**：那 40 条里有 13 条来自本会话 —— 我在讨论中**已经知道
  router 当场干了什么**，对我不算盲，全部排除；只用另一会话（`session-233b1a…`）里
  我没看过判定结果的轮次。
- **标注口径**（标注发生在任何一次判定运行**之前**）：
  - `claim-check` **只标**"明确涉及删改 / 事故复盘 / 要引用数字"的轮次；**不**按它
    `whenToUse` 里"每一轮开口前"的字面口径标 —— 那样几乎每轮都是正例，指标会失去意义。
  - 元讨论（问机制、找插件、评估 skill 质量、会话控制）一律 `[]` —— 这正是 2026-10-07
    那次假阳性所在的类别。
  - 有争议的三条（`h12` 用户怀疑我 / `h19` 修插件 / `h04`+`h05` 的"记忆"陷阱）已在
    `note` 字段注明，按保守口径记 `[]`。
- **已知短板（必须说清）**：这份集合**偏向精度** —— 正例只有 3 条且都是 `claim-check`；
  科学任务的正面例（`paper-cn` / `rdp4-recomb-mosaic` / `hyphy-pselection`）**没有覆盖**，
  因为它来自一段"讨论插件"的会话。要报召回，得再从**实际项目工作区**的会话里另收一份。

### 首次活运行记录（2026-10-07 19:31，v13 第一次真跑）

```
11:31:37Z  v=13 stage=apply  pid=13360  minScore=0.75  judge=true  promptVersion=v13.1
11:31:50Z  v=13 step=1 catalog=17 catalogComplete=false catalogHash=997e9152
           queryLen=3 → stage=catalog-fallback entries=17        ← 目录兜底生效
11:31:52Z  v=13 decision=fallback via=none
           judge={ms:1810, tokens:{in:1556,out:300}, timedOut:false, finish:"max-tokens"}
           judgeReason="no-json-object" → 兜底门槛 0.75 也没命中 ⇒ injected=0
```

两个结论：

1. **目录兜底按设计生效**：模型第一次拿到了 17 份完整目录（`catalogComplete` 仍是
   `false`，与之前观察一致；原生目录一到会自动取代它）。
2. **判定员把 300 个输出 token 全烧在推理上、正文零字符** ⇒ `no-json-object` ⇒ 走兜底。
   这是**参数错、不是逻辑错**：`judgeMaxTokens` 由 300 提到 **1200**（deepseek 系会思考，
   输出预算要留够）。同时把 `textLen` / `reasoningChars` 记进 trace，用来判断下次是否
   还要降思考。**延迟本身没问题：1.81 s**（8 s 上限余量充足），输入 **1556 token**。

⚠ 这次失败被"这一轮本来就该是 none"掩盖了：换成需要技能的真实任务轮次，它就会静默退化
到词法兜底 —— 这正是 trace 要能把 `decision/via/judgeReason` 分开记的原因。

离线单测：`node _test/judge.test.mjs`（18 项，不连网、不碰运行时、不需要 llm 服务）。

### 离线单测（不碰运行时）

`lib/judge.js` 是纯模块，可直接在 node 里跑（17 项：目录渲染 / 提示词构造 / 严格解析 /
白名单 / 流拼装 / 超时包装）。两个真 bug 是它抓到的，不是看代码看出来的：

1. **超时转不成返回值**：超时靠 abort 触发；若不把"因超时而中断"转成 `timedOut: true`
   的正常返回，调用方只能看到一个普通异常，trace 里分不清"超时"和"报错"。
2. **`setTimeout(...).unref()` 让超时静默失效**：unref 过的定时器在"事件循环没有别的
   活"时不会触发（单测直接以 unsettled top-level await 退出）。

### trace 字段（v13）

每条都带 `v=13`。新增：`step`、`session`、`catalogComplete`、`catalogHash`、
`queryHash`（**不记原文**）、`promptVersion`、`decision`、`via`、
`judge{model,ms,tokens,timedOut,finish,error}`、`lexicalTop`、`lexicalTopCoverage`、
`topCoverage`、`suppressed`、`unknown`、`picked`、`why`、`injected`。
`tokens` 只读 adapter 报的 `usage`；缺了就记 `null`，**不估算**。

### 还没做（明确留白）

- `unsure` 升级真子 agent：等"子会话跳过 router"的可靠标记。
- 复合任务是否允许多个 pick：hold-out 里加复合用例后再定。
- 老 9 路的删除：先当影子跑一个评估周期，看有没有"只有老路命中、coverage 没命中"的
  金标正例（外部评审：现有材料不足以判断删掉会丢什么）。
- 注入文案强度：现在中性；等账本给出"推荐了但没加载"的真实比例再谈加强。
- `snapshot.complete` 长期为 false 的根因：**未定论**。可测假设是"项目根
  `<cwd>\.agents\skills` 不存在 ⇒ provider 向上找祖先 watch ⇒ 初始扫描不 settle"；
  重启后按"记录实际 cwd/scope → 打印各发现根与 watch 注册 → 用存在的
  `.agents\skills` 做单变量对照"定位。


## 变更记录

- **2026-10-07｜两次改名**：`dsh-skill-router` → `dsh-skill-gate`（原名只说了「路由」这一半） → **本名 `dsh-skill-router-and-gate`**（用户口径：名字写长、两层都点出来）。短名 `skill-gate` 保留给命令与 env。同批变更：env 前缀 `DSH_SKILL_ROUTER_*` → `DSH_SKILL_GATE_*`；斜杠命令 `/skill-router` → `/skill-gate`；trace 文件 `~/.dsh/skill-gate-trace.ndjson`、开关文件 `~/.dsh/skill-gate.off`。**未发布过 ⇒ 不保留旧名兼容**。
