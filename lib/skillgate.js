/**
 * skillgate.js — 「技能闸」：把"该加载技能"从**建议**变成**闸门**。
 *
 * 起因（用户 2026-10-07 原话）：
 *   「但是问题不是你一直不调用这些技能吗，这是什么原因」
 *   「我现在主要担心会不会出现类似误伤某些指令以及可靠性和稳定性，你要修就修吧」
 *
 * 根因（三条，都有账本）：
 *   ① 官方目录通道被它自己的闸门挡住：app.asar 原文
 *      `const snapshot = await ctx.skills.snapshot({...}); if (!snapshot.complete) return decision;`
 *      本机 trace 里 `catalogComplete` 15 条全 False ⇒ 官方 <available_skills> 一次都没送过。
 *   ② 路由器的候选注入只覆盖"判定命中的那几轮"（injected 28 次），全量目录只兜 4 次。
 *   ③ **清单是"建议"不是闸门** ⇒ 我遇到活儿默认写一次性脚本，跳过加载。本模块治 ③。
 *
 * ── 设计原则（对应"误伤 / 可靠性 / 稳定性"三条担心）──
 *   A. **只认代码上下文，不认裸词**：`\bimport\s+openpyxl\b`、`load_workbook(`、`DictReader(` …
 *   B. **只豁免"整条语句本身就是搜索命令"**：见 v14.1 的修正（原写法是"语句里出现搜索工具名就跳过"，
 *      那是**可复现的漏拦路径**）。
 *   C. **注释不算**：整行 `#` 注释与 PowerShell `<# … #>` 块先剥掉。
 *   D. **三道兜底**（任何一道命中就放行，绝不卡死）：技能缺失 / 拦够次数 / 异常。
 *   E. **开关**：`cfg.skillGate=false` / `DSH_SKILL_GATE_SKILL_GATE=off`；另有全局 kill switch。
 *
 * ── v14.1（2026-10-07，按 Codex/GPT 评审改了 5 处）──
 *   GPT 结论原文摘要：「给出的正则是在文本里找 API 名称，不是 PowerShell/Python/R 的语法解析器……
 *   搜索语句整条跳过会放过真实解析命令，这是可复现的漏拦路径……」据此：
 *   ① **搜索豁免收紧到"整条语句以搜索命令开头"**（原来只要出现就豁免 ⇒ 管道上游的解析操作被放过）；
 *   ② **`Import-Csv` / `Import-Excel` 也要求命令行位置**（原来 `Get-Help Import-Csv -Examples`
 *      这种"查帮助"也会被误拦）；
 *   ③ **全部规则加 `i` 标志**（PowerShell 命令名大小写不敏感，`import-csv` 不该漏）；
 *   ④ **PDF CLI 支持 `.exe`、引号路径、绝对路径**，并**补 R 的 `require`/`requireNamespace`/`pdftools::*`**；
 *   ⑤ 收敛前先定策略边界：**"只 import 来看版本号"也算命中**（目标是"要碰这类文件就先读技能"）。
 *
 * 已知覆盖边界（**不是** bug，是这类文本闸的物理极限，已写进测试当预期）：
 *   · 引号/字符串里提到调用形式（`Write-Output '先看 DictReader( 的用法'`）会被误拦；
 *   · PowerShell here-string 里写**文档**（而非代码）会被误拦（写代码送进解释器则应拦）；
 *   · `write` 工具写 .py 再 `python x.py`、`Get-Content a.py | python -` 看不到源码内容 ⇒ 不拦。
 */

/** 命令行位置前缀：语句开头，或 `;`/`&`/`|` 之后；可选 `&` 调用符与 Windows 路径/引号路径。 */
const CMD_POS = String.raw`(?:^|[;&|]\s*)(?:&\s*)?(?:(?:"[^"\r\n]*[\\/]|'[^'\r\n]*[\\/])|(?:[A-Za-z]:[\\/][^\s"';&|]*[\\/]))?`;

/** 只豁免"这条语句本身就是搜索命令"（锚在语句开头）。 */
const SEARCH_ONLY = /^\s*(?:&\s*)?(?:Select-String|findstr(?:\.exe)?|grep(?:\.exe)?|rg(?:\.exe)?|sls)\b/i;

/** 去掉成对引号里的内容（引号里的 `|` 是搜索模式，不是管道）。 */
const stripQuoted = (s) => String(s).replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, " ");

/**
 * v14.2（外部评审）：**只有"整条语句确实只是一条搜索命令"才豁免**。
 * 旧写法（v14.1）只看语句开头是不是搜索命令，于是
 *   `grep x f | python -c "import openpyxl"` 被**整条**丢掉 —— 可复现的漏拦路径
 *   （管道后半段的解析调用被豁免了）。
 * 现在：**引号外**出现 `|` 或 `&` 一律说明"后面还有别的命令" ⇒ 不豁免，交给各条规则逐句匹配。
 * 注意：引号里的 `|`（`Select-String -Pattern 'openpyxl|load_workbook'`）仍是纯搜索，必须继续豁免。
 */
export function isPureSearch(stmt) {
  if (!SEARCH_ONLY.test(stmt)) return false;
  return !/[|&]/.test(stripQuoted(stmt).replace(/^\s*&\s*/, ""));
}

/** R 侧 pdftools：库/require/命名空间三种写法（原本只有 library(...)）。 */
const PDF_R = String.raw`\b(?:library|require)\s*\(\s*["']?pdftools["']?\s*\)|\brequireNamespace\s*\(\s*["']pdftools["']\s*\)|\bpdftools\s*::\s*(?:pdf_text|pdf_render_page|pdf_fonts|pdf_info)\s*\(`;

/** pdftotext：命令行位置 + 允许 `.exe` 与引号/绝对路径（原来只认裸名）。 */
const PDF_CLI = CMD_POS + String.raw`pdftotext(?:\.exe)?(?=(?:["']|\s|$))`;

const R = (src) => new RegExp(src, "i");

/** 受管格式 → 必须加载的技能。**模式一律要求代码上下文。** */
export const SKILL_GATE = [
  {
    skill: "office-xlsx",
    what: "Excel workbook",
    re: R(
      String.raw`\bimport\s+openpyxl\b|\bfrom\s+openpyxl\b|\bload_workbook\s*\(|\bread_excel\s*\(|` +
        String.raw`\bExcelWriter\s*\(|\.to_excel\s*\(|` +
        CMD_POS +
        String.raw`Import-Excel\b`,
    ),
  },
  {
    skill: "office-docx",
    what: "Word document",
    re: R(String.raw`\bimport\s+docx\b|\bfrom\s+docx\b|\bdocx\.Document\s*\(`),
  },
  {
    skill: "office-pptx",
    what: "PowerPoint",
    re: R(String.raw`\bimport\s+pptx\b|\bfrom\s+pptx\b|\bpptx\.Presentation\s*\(`),
  },
  {
    skill: "pdf",
    what: "PDF",
    re: R(
      String.raw`\bimport\s+(fitz|pypdf|PyPDF2|pdfplumber|pymupdf)\b|` +
        String.raw`\bfrom\s+(fitz|pypdf|PyPDF2|pdfplumber|pymupdf)\b|` +
        String.raw`\bfitz\.open\s*\(|\bPdfReader\s*\(|\bpdf_render_page\s*\(|\bpdf_fonts\s*\(|` +
        PDF_R +
        `|` +
        PDF_CLI,
    ),
  },
  {
    skill: "tabular-read",
    what: "CSV/TSV table",
    re: R(
      String.raw`\bDictReader\s*\(|\bcsv\.reader\s*\(|\bread_csv\s*\(|\bread_table\s*\(|` +
        String.raw`\bread\.delim\s*\(|\bread\.csv\s*\(|` +
        CMD_POS +
        String.raw`Import-Csv\b`,
    ),
  },
];

/** 只有会执行命令的工具受管；`skill` 工具自身永不放倒（否则死锁）。 */
const GATED_TOOLS = /^(pwsh|bash|workflow|run_code)$/;

/** 把命令切成"语句"，并剥掉注释。与删除闸（v12）同一处理：JSON 里换行是字面 `\n`。 */
export function gateStatements(text) {
  const unwrapped = String(text ?? "").replace(/\\r\\n|\\n|\\r/g, "\n");
  const noBlock = unwrapped.replace(/<#[\s\S]*?#>/g, " ");
  return noBlock
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^#/.test(s)) // 整行注释剥掉
    .filter((s) => !isPureSearch(s)); // ⚠ v14.2：只豁免"整条语句确实只是一条搜索命令"
}

/**
 * 取出**真正的命令文本**。
 * ⚠ 不能直接拿 `JSON.stringify(arguments)` 去匹配：那样语句开头是 `{"command":"`，
 * 于是所有"命令行位置"（`^`）的判断在真实运行时全部失效——本模块第一版就栽在这里
 *（`pdftotext a.pdf out.txt` 漏拦，而散文里的 `pdftotext` 又被误伤）。
 */
export function commandText(exec) {
  const a = exec?.arguments;
  if (typeof a === "string") return a;
  if (a && typeof a === "object") {
    for (const k of ["command", "code", "script", "cmd", "input", "stdin"]) {
      const v = a[k];
      if (typeof v === "string" && v) return v;
    }
    try {
      return JSON.stringify(a);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * @param {{name?: string, arguments?: unknown}} exec 工具调用
 * @param {{loaded?: Set<string>, known?: Set<string>|null, denies?: Map<string,number>,
 *          maxDeny?: number, enabled?: boolean}} [opts]
 * @returns {null | {action:'deny'|'giveup'|'skip'|'off', skill?:string, what?:string, reason?:string}}
 */
export function skillGateDecision(exec, opts = {}) {
  const { loaded, known = null, denies = null, maxDeny = 3, enabled = true } = opts;
  const name = exec?.name;
  if (typeof name !== "string") return null;
  if (name === "skill") return null;
  if (!GATED_TOOLS.test(name)) return null;
  if (enabled === false) return { action: "off" };

  let text;
  try {
    text = commandText(exec);
  } catch {
    return null;
  }

  for (const stmt of gateStatements(text)) {
    for (const g of SKILL_GATE) {
      if (!g.re.test(stmt)) continue;
      if (loaded && loaded.has(g.skill)) continue;
      // 兜底①：技能不在目录里 ⇒ 没有可加载的东西，放行
      if (known instanceof Set && !known.has(g.skill)) {
        return { action: "skip", skill: g.skill, what: g.what, reason: `${g.skill} is not in the current catalog; allowing` };
      }
      // 兜底②：拦够了仍加载不上 ⇒ 放行，防卡死
      const n = denies?.get?.(g.skill) ?? 0;
      if (n >= maxDeny) {
        return { action: "giveup", skill: g.skill, what: g.what, reason: `${g.skill} refused ${n} times and never loaded; allowing` };
      }
      return {
        action: "deny",
        skill: g.skill,
        what: g.what,
        reason: `skill-gate: this command **parses ${g.what}**, but the matching skill has not been ` +
          `loaded in this session. Load it first — skill(name="${g.skill}") — and re-send the same ` +
          `command unchanged. (That skill records which library this machine actually has and the ` +
          `traps already hit with this format; skipping the load is what has gone wrong repeatedly.)`,
      };
    }
  }
  return null;
}
