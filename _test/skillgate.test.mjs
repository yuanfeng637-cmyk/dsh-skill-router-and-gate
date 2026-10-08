/**
 * skillgate 单元测试：node --test _test/skillgate.test.mjs
 * 全部离线，不碰宿主运行时。
 *
 * 分四组：
 *   ① 该拦的（真解析行为，含 v14.1 按 GPT 评审补的：搜索管道上游、大小写、.exe/路径、R 变体）
 *   ② 不该拦的（误伤语料：搜索、注释、裸扩展名、散文、脚本文件名）
 *   ③ 稳定性兜底（技能缺失 / 拦够次数 / 开关 / 异常）
 *   ④ **已知覆盖边界**（有意保留的误伤/漏拦，写成预期，不当 bug）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillGateDecision, gateStatements, commandText, SKILL_GATE } from "../lib/skillgate.js";

const pwsh = (command) => ({ name: "pwsh", arguments: { command } });
const none = new Set();
const knownAll = new Set(SKILL_GATE.map((g) => g.skill));
const ok = (cmd, opts) => assert.equal(skillGateDecision(pwsh(cmd), opts), null, cmd);
const denied = (cmd, skill) => {
  const r = skillGateDecision(pwsh(cmd), {});
  assert.equal(r?.action, "deny", cmd);
  assert.equal(r?.skill, skill, cmd);
};
const ok0 = (exec) => assert.equal(skillGateDecision(exec, {}), null, JSON.stringify(exec));

test("技能名与两个技能目录一致", () => {
  assert.deepEqual(SKILL_GATE.map((g) => g.skill),
    ["office-xlsx", "office-docx", "office-pptx", "pdf", "tabular-read"]);
});

/* ─────────── ① 该拦的 ─────────── */
test("拦：xlsx 解析", () => {
  denied("python -c \"import openpyxl; openpyxl.load_workbook(p)\"", "office-xlsx");
  denied("python -c \"import pandas as pd; pd.read_excel('a.xlsx')\"", "office-xlsx");
  denied("python s.py  # 里面 load_workbook(p)", "office-xlsx");
});

test("拦：docx / pptx 解析", () => {
  denied("python -c \"from docx import Document; Document(p)\"", "office-docx");
  denied("python -c \"import docx; docx.Document(p)\"", "office-docx");
  denied("python -c \"from pptx import Presentation; pptx.Presentation(p)\"", "office-pptx");
});

test("拦：PDF 解析（Python / R / CLI 三路）", () => {
  denied("python -c \"import fitz; fitz.open(p)\"", "pdf");
  denied("python -c \"from pypdf import PdfReader\"", "pdf");
  denied("Rscript -e 'pdftools::pdf_fonts(\"a.pdf\")'", "pdf");
});

test("拦：表格解析（tip_name 那次事故的命令形态）", () => {
  denied("python -c \"import csv; rows=list(csv.DictReader(open(p, encoding='utf-8-sig'), delimiter='\\\\t'))\"", "tabular-read");
  denied("python -c \"import pandas as pd; pd.read_csv('a.tsv', sep='\\\\t')\"", "tabular-read");
  denied("Import-Csv a.tsv", "tabular-read");
  denied("Rscript -e 'read.delim(\"a.tsv\")'", "tabular-read");
});

/* ── v14.1：GPT 评审的 P0/P1 补充 ── */
test("P0 拦：搜索管道**不得**放过上游解析操作（原实现是漏拦）", () => {
  denied("python -c \"import openpyxl; print(openpyxl.__version__)\" | Select-String \"3\"", "office-xlsx");
  denied("Import-Csv .\\data.csv | sls foo", "tabular-read");
  denied("python -c \"import pandas as pd; pd.read_csv('a.tsv')\" | rg foo", "tabular-read");
});

test("P0 拦：PowerShell 命令名大小写不敏感（import-csv / IMPORT-EXCEL）", () => {
  denied("import-csv .\\data.csv", "tabular-read");
  denied("IMPORT-EXCEL .\\book.xlsx", "office-xlsx");
  denied("IMPORT-CSV a.tsv", "tabular-read");
});

test("P0 拦：pdftotext 的 .exe 与引号/绝对路径写法", () => {
  denied("pdftotext a.pdf out.txt", "pdf");
  denied("pdftotext.exe input.pdf output.txt", "pdf");
  denied("& \"C:\\Tools\\Poppler\\pdftotext.exe\" input.pdf output.txt", "pdf");
  denied("C:\\Tools\\Poppler\\pdftotext input.pdf output.txt", "pdf");
});

test("P1 拦：R 的 require / requireNamespace / pdftools:: 变体", () => {
  denied("Rscript -e 'pdftools::pdf_text(\"x.pdf\")'", "pdf");
  denied("Rscript -e 'require(pdftools)'", "pdf");
  denied("Rscript -e 'requireNamespace(\"pdftools\")'", "pdf");
  denied("Rscript -e 'library(pdftools)'", "pdf");
});

test("P1 拦：here-string 送代码进解释器、多语句、cmd /c 包装", () => {
  denied("$code = @'\\nimport openpyxl\\n'@\\n$code | & $py -", "office-xlsx");
  denied("Get-ChildItem; python -c \"import openpyxl\"", "office-xlsx");
  denied("cmd /c \"python -c `\"import openpyxl`\"\"", "office-xlsx");
  denied("& $py -3 -c \"import openpyxl\"", "office-xlsx");
});

test("P1 拦：真实参数形态的六种字段名都要能取到命令", () => {
  for (const k of ["command", "code", "script", "cmd", "input", "stdin"]) {
    const exec = { name: "pwsh", arguments: { [k]: "python -c \"import openpyxl\"" } };
    assert.equal(skillGateDecision(exec, {})?.skill, "office-xlsx", k);
    assert.equal(commandText(exec), "python -c \"import openpyxl\"", k);
  }
});

/* ─────────── ② 不该拦的（误伤语料） ─────────── */
test("放行：只列 / 只搬 / 只删文件（裸扩展名不触发）", () => {
  ok("Get-ChildItem 'D:\\work\\proj' -Recurse -Include '*.pdf'");
  ok("Get-ChildItem 'D:\\x\\a.xlsx' | Select-Object Name,Length");
  ok("Copy-Item a.pdf b.pdf -Force");
  ok("Remove-Item 'C:\\tmp\\old.pdf'");
});

test("放行：**整条语句本身就是搜索命令**（读文本 ≠ 解析受管格式）", () => {
  ok("Select-String -Path 'D:\\x\\*.py' -Pattern 'openpyxl|load_workbook'");
  ok("grep -n 'DictReader(' src/*.py");
  ok("rg \"read_excel\\(\" .");
  ok("findstr /s \"pdftools\" *.R");
  ok("sls 'pdftotext' .\\notes.md");
});

test("放行：查帮助 / 查命令本身，不是调用", () => {
  ok("Get-Help Import-Csv -Examples");
  ok("Get-Command Import-Excel");
  ok("Get-Command pdftotext -ErrorAction SilentlyContinue");
});

test("放行：整行注释与 <# #> 块注释里的词", () => {
  ok("python -c \"x=1\"  \n# openpyxl 说明：见技能");
  ok("Write-Output hi <# import openpyxl; DictReader( #>");
});

test("放行：散文式提及（没有代码上下文）", () => {
  ok("Write-Output 'office-xlsx 技能讲的是 openpyxl 的用法'");
  ok("Write-Output '本机没有 pdfplumber、没有 pdftotext'");
  ok("Get-ChildItem $B | Where-Object { $_.Name -match 'fitz' }");
});

test("放行：跑一个现成脚本（命令行里没有解析词）", () => {
  ok("python \"$env:TEMP\\geno_compare.py\"");
  ok("& $py (Join-Path $T '05_建表_build_mosaic.py') --rdp-dir $R");
  ok("node --test _test/skillgate.test.mjs");
  ok("pwsh -NoProfile -File '.\\refresh.ps1'");
  ok("& 'D:\\tools\\R\\bin\\Rscript.exe' 'D:\\work\\proj\\fig\\plot.R'");
  ok("python -c \"print(sum(range(10)))\"");
});

test("放行：skill 工具自身 / 非命令类工具 / 参数形态异常", () => {
  ok0({ name: "skill", arguments: { name: "pdf" } });
  ok0({ name: "read", arguments: { file_path: "a.tsv" } });
  ok0({ name: "write", arguments: { file_path: "a.py", content: "import openpyxl" } }); // 已知代价：write 不受管
  ok0({ name: "edit", arguments: { file_path: "a.py", old_string: "import openpyxl" } });
  ok0({ name: "pwsh" }); // 没有 arguments
  ok0({ arguments: { command: "x" } }); // 没有 name
  ok0({ name: "pwsh", arguments: { command: "" } });
});

test("放行：加载过对应技能之后", () => {
  ok("python -c \"import openpyxl; openpyxl.load_workbook(p)\"", { loaded: new Set(["office-xlsx"]) });
  ok("python -c \"import csv; csv.DictReader(f)\"", { loaded: new Set(["tabular-read"]) });
});

/* ─────────── ③ 稳定性兜底 ─────────── */
test("兜底①：技能不在目录清单里 ⇒ 放行（没有东西可加载）", () => {
  const r = skillGateDecision(pwsh("python -c \"import openpyxl\""), { known: new Set(["pdf"]) });
  assert.equal(r?.action, "skip");
  assert.equal(skillGateDecision(pwsh("python -c \"import openpyxl\""), { known: knownAll })?.action, "deny");
});

test("兜底②：同一技能拦够 maxDeny 次 ⇒ 放行（防死循环）", () => {
  const r = skillGateDecision(pwsh("python -c \"import openpyxl\""), { denies: new Map([["office-xlsx", 3]]), maxDeny: 3 });
  assert.equal(r?.action, "giveup");
  assert.equal(skillGateDecision(pwsh("python -c \"import openpyxl\""), { denies: new Map([["office-xlsx", 2]]), maxDeny: 3 })?.action, "deny");
});

test("兜底③ / 开关：enabled=false ⇒ off（放行）", () => {
  assert.equal(skillGateDecision(pwsh("python -c \"import openpyxl\""), { enabled: false })?.action, "off");
});

test("gateStatements：字面 \\n 还原 / 注释剥离 / 只豁免纯搜索语句", () => {
  assert.deepEqual(gateStatements("a;b"), ["a", "b"]);
  assert.deepEqual(gateStatements("python - <<'PY'\\nimport openpyxl\\nPY"), ["python - <<'PY'", "import openpyxl", "PY"]);
  assert.deepEqual(gateStatements("# import openpyxl").length, 0);
  assert.deepEqual(gateStatements("grep 'import openpyxl' f.py").length, 0); // 纯搜索 → 豁免
  assert.deepEqual(gateStatements("python -c 'import openpyxl' | Select-String x").length, 1); // 上游解析 → 不豁免
  assert.deepEqual(gateStatements("<# import openpyxl #> Get-Date").map((s) => s.trim()), ["Get-Date"]);
});

test("表里每个 regex 都能编译、不匹配空串、带 i 不带 g", () => {
  for (const g of SKILL_GATE) {
    assert.equal(g.re.test(""), false, g.skill);
    assert.equal(g.re.flags.includes("g"), false, `${g.skill} 不能用 g 标志（lastIndex 会串）`);
    assert.equal(g.re.flags.includes("i"), true, `${g.skill} 必须带 i（PowerShell 命令名大小写不敏感）`);
  }
});

/* ─────────── ④ 已知覆盖边界（有意保留，写成预期） ─────────── */
test("边界：字符串/行内注释里提到调用形式 ⇒ 会拦（代价是加载一次技能）", () => {
  denied("Write-Output '先看 DictReader( 的用法'", "tabular-read");
  denied("Write-Output ok # example: read_excel(", "office-xlsx");
  denied("python -c \"print('from docx import Document')\"", "office-docx");
});

test("边界：here-string 内容一律算命中（写文档也会被拦一次）", () => {
  // 决策（我的，不是 GPT 的）：不过滤 here-string —— 它同时是我把代码送进解释器的主要写法，
  // 放过它等于把闸门最大的入口敞开。代价：写文档时可能被拦一次。
  denied("$note = @'\\n示例：from docx import Document\\n'@\\nSet-Content note.md $note", "office-docx");
});

test("边界：只看得到命令行的脚本执行 ⇒ 不拦（有意留的余地）", () => {
  ok("python .\\script.py");
  ok("Get-Content .\\script.py | python -");
  ok(".\\script.ps1");
});

/* ─────────── ⑤ v14.2 回归：搜索豁免不能放过管道后半段（外部评审） ─────────── */
test("拦：搜索命令 + 管道 + 解析（旧版整条豁免 = 漏拦）", () => {
  denied("Select-String -Path 'D:\\x\\*.py' | python -c \"import openpyxl; openpyxl.load_workbook(p)\"", "office-xlsx");
  denied("grep -n foo f.txt | python -c \"import pandas as pd; pd.read_excel('a.xlsx')\"", "office-xlsx");
  denied("Select-String a f | python -c \"import csv; csv.DictReader(open('x.csv'))\"", "tabular-read");
});

test("拦：搜索命令与解析用 `&` / `&&` 串联", () => {
  denied("Select-String a f & python -c \"import openpyxl\"", "office-xlsx");
  denied("grep a f && python -c \"import fitz; fitz.open(p)\"", "pdf");
});

test("放行：引号里的 `|` 仍是纯搜索（v14.1 既有豁免不能被这次修坏）", () => {
  ok("Select-String -Path 'D:\\x\\*.py' -Pattern 'openpyxl|load_workbook'");
  ok("grep -E 'DictReader|read_excel' f.txt");
  ok("Select-String a f | Select-String b");
});
