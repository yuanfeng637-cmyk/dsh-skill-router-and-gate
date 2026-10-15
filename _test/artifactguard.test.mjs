/**
 * artifactguard 单元测试（v20）：node --test _test/artifactguard.test.mjs
 *
 * 覆盖 8 条规则中**每一条能确定性判定的**行为，以及"不许误拦"的对照面：
 *   R1 禁回收站   R2 产物登记   R3 文体声明(+specs)   R4 交接前置(本轮+内容哈希)
 *   R5 参数闸     R6 路径别名(UNC/符号链接)          R7 shell 写入登记
 *   R8 候选处置(+not_installed 核实/豁免)
 * 另有 fail-open（策略缺失/字段缺失一律不拦）与 glob 语义。
 * 每条规则的用例都对应一次**真实发生过的失败**（见 lib/artifactguard.js 头部注释）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile, link } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactGuard, globToRe, readKey } from "../lib/artifactguard.js";

/** 造临时项目：cwd = <root>/proj；策略在 <root>/policy.json。 */
async function setup(artifact, existing = [], actions = [{ command: "registered-cmd", files: [] }]) {
  const root = await mkdtemp(join(tmpdir(), "ag-"));
  const cwd = join(root, "proj");
  await mkdir(cwd, { recursive: true });
  const policyPath = join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify({ version: 1, protect: ["nothing"], actions, artifact }), "utf8");
  for (const rel of existing) {
    const p = join(cwd, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "existing", "utf8");
  }
  const g = createArtifactGuard({ policyPath });
  const exec = (name, args) => ({ name, arguments: args, agent: { session: { header: { cwd } } } });
  return { g, cwd, root, policyPath, exec };
}
const CTX = { reads: new Set(), picks: null, loaded: new Set() };
const ctxOf = (o = {}) => ({ ...CTX, ...o });
const shaOf = async (p) => createHash("sha256").update(await readFile(p)).digest("hex");

test("R1 禁回收站：移动到垃圾/回收站类目录拦；彻底删除与非回收站移动放行", async () => {
  const { g, exec } = await setup({ noRecycleBin: true });
  assert.equal((await g.pre(exec("pwsh", { command: "Move-Item -LiteralPath 'D:/proj/a.md' -Destination 'D:/proj/_trash/'" }), "s", ctxOf()))?.kind, "deny");
  assert.equal((await g.pre(exec("bash", { command: "mv a.md .trash/" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "Remove-Item -LiteralPath 'D:/proj/a.md' -Recurse -Force" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Move-Item a.md b.md" }), "s", ctxOf()), null);
});

test("R2 产物登记：新建未登记文件拦；allowNew/scratch 放行；覆盖已存在文件放行", async () => {
  const { g, exec } = await setup({ allowNew: ["analysis_set/*.tsv"], scratch: ["tmp/**"] }, ["chikv1011/README.md"]);
  assert.equal((await g.pre(exec("write", { file_path: "chikv1011/ALIGNMENT.md", content: "# x" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/new.tsv", content: "a" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("write", { file_path: "tmp/scratch.md", content: "# x" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("write", { file_path: "chikv1011/README.md", content: "# 改" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("write", { file_path: "C:/Windows/Temp/x.md", content: "# x" }), "s", ctxOf()), null);
});

test("R3 文体声明：无 genre 行拦；允许值放行；specs 可把某路径限死到特定文体", async () => {
  const { g, exec } = await setup({ genrePaths: ["**/METHODS*.md"], allowNew: ["METHODS.md"] });
  assert.equal((await g.pre(exec("write", { file_path: "METHODS.md", content: "# 材料方法\n……" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("write", { file_path: "METHODS.md", content: "# 材料方法\ngenre: methods\n……" }), "s", ctxOf()), null);
  const { g: g2, exec: e2 } = await setup(
    { specs: [{ paths: ["**/METHODS*.md"], genre: ["methods"] }], allowNew: ["METHODS.md"] });
  assert.equal((await g2.pre(e2("write", { file_path: "METHODS.md", content: "genre: notes\n……" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g2.pre(e2("write", { file_path: "METHODS.md", content: "genre: methods\n……" }), "s", ctxOf()), null);
});

test("R4 交接前置：本轮未完整读取（内容哈希绑定）时拦；读过后放行；文件改动即失效", async () => {
  const { g, cwd, exec } = await setup({ requireReads: [".ccm/PROGRESS.md"], allowNew: ["analysis_set/*.tsv"] },
    [".ccm/PROGRESS.md"], [{ command: "registered-cmd", files: [] }]);
  const w = await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", ctxOf());
  assert.equal(w?.kind, "deny");
  assert.match(w.reason, /R4/);
  assert.equal((await g.pre(exec("pwsh", { command: "registered-cmd" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date" }), "s", ctxOf()), null); // 未登记命令不在此列
  const p = join(cwd, ".ccm", "PROGRESS.md");
  // 只给路径：不算证据
  assert.equal((await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", ctxOf({ reads: new Set([p]) })))?.kind, "deny");
  // 绑定内容哈希：放行
  const ok = ctxOf({ reads: new Set([readKey(p, await shaOf(p))]) });
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", ok), null);
  // 读完之后文件改变 ⇒ 旧证据失效
  await writeFile(p, "changed", "utf8");
  assert.equal((await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", ok))?.kind, "deny");
});

test("R4 对照面：requireReads 指向的文件不存在 ⇒ 放行（无对象可读，不卡死）", async () => {
  const { g, exec } = await setup({ requireReads: [".ccm/PROGRESS.md"], allowNew: ["analysis_set/*.tsv"] });
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", ctxOf()), null);
});

test("R5 参数闸：取值必须等于有效裁定；重复与引号夹带都拦；别家工具不套用", async () => {
  const guard = { name: "线程数", tool: "iqtree3|mafft", regex: "-T\\s+(\\d+)|--threads?\\s+(\\d+)", allowed: ["32"] };
  const { g, exec } = await setup({ paramGuards: [guard] });
  assert.equal((await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 64 -m MFP" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 32 -m MFP" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "mafft --auto --thread 32 in.fa" }), "s", ctxOf()), null);
  assert.equal((await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 32 -T 64" }), "s", ctxOf()))?.kind, "deny");
  assert.equal((await g.pre(exec("pwsh", { command: "echo \"-T 32\"; iqtree3 -s aln.fa -T 64" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "other-tool -T 64" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "mafft --auto in.fa" }), "s", ctxOf()), null);
});

test("R6 路径别名：UNC 拦；硬链接拦；符号链接/junction 拦（本机无特权时跳过该断言）", async () => {
  const { g, cwd, exec } = await setup({ allowNew: ["**"] });
  assert.equal((await g.pre(exec("write", { file_path: "\\\\server\\share\\x.md", content: "y" }), "s", ctxOf()))?.kind, "deny");

  // 硬链接：普通用户即可创建 ⇒ 必须拦（改一个会改到范围外的同一文件）
  const real = join(cwd, "real.md");
  await writeFile(real, "real", "utf8");
  const hard = join(cwd, "hard.md");
  await link(real, hard);
  assert.equal((await g.pre(exec("write", { file_path: hard, content: "y" }), "s", ctxOf()))?.kind, "deny");

  // 文件符号链接（Windows 默认 EPERM）
  const linkPath = join(cwd, "link.md");
  try {
    await symlink(real, linkPath);
  } catch (error) {
    assert.equal(error.code, "EPERM");   // 如实跳过，不伪装通过
  }
  if (existsSync(linkPath)) {
    assert.equal((await g.pre(exec("write", { file_path: linkPath, content: "y" }), "s", ctxOf()))?.kind, "deny");
  }

  // 父目录 junction：新建文件落在链接目录里 ⇒ 拦
  const realDir = join(cwd, "realdir");
  await mkdir(realDir, { recursive: true });
  const junc = join(cwd, "junc");
  try {
    await symlink(realDir, junc, "junction");
  } catch { /* 无权限就跳过 */ }
  if (existsSync(junc)) {
    assert.equal((await g.pre(exec("write", { file_path: "junc/new.md", content: "y" }), "s", ctxOf()))?.kind, "deny");
  }
});

test("R7 shell 写入登记：重定向/Out-File 写项目内未登记路径拦；已登记与项目外放行", async () => {
  const { g, exec } = await setup({ allowNew: ["analysis_set/*.tsv"], scratch: ["tmp/**"] });
  const bad = await g.pre(exec("pwsh", { command: "Get-Date > chikv1011/SOMETHING.md" }), "s", ctxOf());
  assert.equal(bad?.kind, "deny");
  assert.match(bad.reason, /R7/);
  assert.equal((await g.pre(exec("pwsh", { command: "Get-Date | Out-File -FilePath 'chikv1011/OTHER.md'" }), "s", ctxOf()))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date > analysis_set/ok.tsv" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date > tmp/x.txt" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date > /tmp/outside.txt" }), "s", ctxOf()), null);
  // 自查实测的误拦场景：引号内的 `>` 不是真写入（远程命令整个包在单引号里）
  assert.equal(await g.pre(exec("pwsh", { command: "Write-Output 'Get-Date > chikv1011/FOO.md'" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "ssh host 'cd x; iqtree3 -s a.fa -T 32 > log/x.log 2>&1'" }), "s", ctxOf()), null);
  // 但显式标志即便带引号也要查
  assert.equal((await g.pre(exec("pwsh", { command: "Out-File -FilePath 'chikv1011/OTHER.md' -InputObject x" }), "s", ctxOf()))?.kind, "deny");
  // 自查实测的第三次误拦：箭头/比较符与不像路径的目标都不是写入
  assert.equal(await g.pre(exec("pwsh", { command: "git commit -m \"VERSION 19 -> 22\"" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date > 22" }), "s", ctxOf()), null);
  assert.equal((await g.pre(exec("pwsh", { command: "Get-Date > out.txt" }), "s", ctxOf()))?.kind, "deny");
  // v22.2：`edit` 也受管（此前只覆盖 write ⇒ 我改文档走 edit 就绕过了）
  assert.equal(await g.pre(exec("edit", { file_path: "analysis_set/ok.tsv", old_string: "a", new_string: "b" }), "s", ctxOf()), null);
  assert.equal((await g.pre(exec("edit", { file_path: "tmp/../chikv1011/ALIGNMENT.md", old_string: "a", new_string: "b" }), "s", ctxOf()))?.kind, "deny");
  const { g: g4, exec: e4 } = await setup({ genrePaths: ["**/METHODS*.md"] }, ["METHODS.md"]);
  assert.equal((await g4.pre(e4("edit", { file_path: "METHODS.md", old_string: "a", new_string: "b" }), "s", ctxOf()))?.kind, "deny");
});

test("R8 候选处置：未处置即拦；加载后放行；枚举理由豁免可放行；谎报 not_installed 拦", async () => {
  const { g, exec } = await setup({ candidateReasons: ["covered_by", "not_installed", "user_waiver"] });
  const picks = { names: ["hyphy-pselection", "project-memory"] };
  const bad = await g.pre(exec("pwsh", { command: "Get-Date" }), "s", ctxOf({ picks }));
  assert.equal(bad?.kind, "deny");
  assert.match(bad.reason, /R8/);
  // 已加载其一、另一个写豁免 ⇒ 放行
  assert.equal(await g.pre(exec("pwsh", { command: "SKIP project-memory reason=covered_by" }), "s",
    ctxOf({ picks, loaded: new Set(["hyphy-pselection"]) })), null);
  // 自由文本理由不算
  assert.equal((await g.pre(exec("pwsh", { command: "SKIP project-memory reason=无关" }), "s",
    ctxOf({ picks, loaded: new Set(["hyphy-pselection"]) })))?.kind, "deny");
  // 谎报 not_installed（技能目录里确实有）⇒ 拦
  assert.equal((await g.pre(exec("pwsh", { command: "SKIP project-memory reason=not_installed" }), "s",
    ctxOf({ picks, loaded: new Set(["hyphy-pselection"]), catalog: new Set(["project-memory"]) })))?.kind, "deny");
  // candidateExempt 里的候选永不强制处置（用户裁定：不必非要加载 grill-me）
  const { g: g3, exec: e3 } = await setup({ candidateExempt: ["grill-me"] });
  assert.equal(await g3.pre(e3("pwsh", { command: "Get-Date" }), "s", ctxOf({ picks: { names: ["grill-me"] } })), null);
});

test("R9 质疑强制：未加载 claim-check 拦；缺四段式拦；判定值不合法拦；通过后由闸门追加台账", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-"));
  const ledger = join(root, "claim-check.ndjson");
  const { g, exec } = await setup({ claimGate: { ledger }, allowNew: ["analysis_set/*.tsv"] });
  const good = "CLAIM: 计数器 = 42\nCOUNTER: 它可能是 41（少读了一条）\nCHECK: 重算一遍并比对\nVERDICT: 已验\n";
  const loaded = new Set(["claim-check"]);
  // ① 未加载 skill ⇒ 拦（强制加载）
  const notLoaded = await g.pre(exec("write", { file_path: "analysis_set/a.tsv", content: good }), "s", ctxOf());
  assert.equal(notLoaded?.kind, "deny");
  assert.match(notLoaded.reason, /R9/);
  // ② 缺四段式 ⇒ 拦（强制记载）
  assert.equal((await g.pre(exec("write", { file_path: "analysis_set/a.tsv", content: "no fields" }), "s", ctxOf({ loaded })))?.kind, "deny");
  // ③ 判定值不合法 ⇒ 拦
  assert.equal((await g.pre(exec("write", { file_path: "analysis_set/a.tsv", content: good.replace("已验", "大概对") }), "s", ctxOf({ loaded })))?.kind, "deny");
  // ④ 合规 ⇒ 放行，且台账里多出一行（闸门自己写，不靠模型自述）
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/a.tsv", content: good }), "s", ctxOf({ loaded })), null);
  const rows = (await readFile(ledger, "utf8")).trim().split("\n");
  assert.equal(rows.length, 1);
  const row = JSON.parse(rows[0]);
  assert.equal(row.verdict, "已验");
  assert.match(row.claim, /计数器/);
  // v23：edit 的正文在 new_string，R9 必须从 new_string 取
  const { g: ge, exec: ee } = await setup({ claimGate: { ledger: join(root, "l2.ndjson") } }, ["analysis_set/a.tsv"]);
  const noBlock = await ge.pre(ee("edit", { file_path: "analysis_set/a.tsv", old_string: "x", new_string: "y" }), "s", ctxOf({ loaded }));
  assert.equal(noBlock?.kind, "deny");
  assert.match(noBlock.reason, /R9/);
  assert.equal(await ge.pre(ee("edit", { file_path: "analysis_set/a.tsv", old_string: "x", new_string: good }), "s", ctxOf({ loaded })), null);
});

test("fail-open：策略缺失、无 artifact 段、非受管工具 ⇒ 一律 null", async () => {
  const { g, exec, policyPath } = await setup({ noRecycleBin: true });
  const gone = createArtifactGuard({ policyPath: policyPath + ".missing" });
  assert.equal(await gone.pre(exec("write", { file_path: "x.md", content: "y" }), "s", ctxOf()), null);
  const { g: g2, exec: e2 } = await setup(null);
  assert.equal(await g2.pre(e2("write", { file_path: "x.md", content: "y" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("read", { file_path: "x.md" }), "s", ctxOf()), null);
  assert.equal(await g.pre(exec("skill", { name: "pdf" }), "s", ctxOf()), null);
});

test("globToRe：`**/` 可匹配零层目录；`*` 不跨目录", () => {
  assert.equal(globToRe("**/METHODS*.md").test("METHODS.md"), true);
  assert.equal(globToRe("**/METHODS*.md").test("chikv1011/sub/METHODS.md"), true);
  assert.equal(globToRe("analysis_set/*.tsv").test("analysis_set/a.tsv"), true);
  assert.equal(globToRe("analysis_set/*.tsv").test("analysis_set/sub/a.tsv"), false);
});
