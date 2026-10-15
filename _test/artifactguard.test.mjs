/**
 * artifactguard 单元测试（v19）：node --test _test/artifactguard.test.mjs
 *
 * 覆盖四类**真实发生过**的失败，以及"不许误拦"的对照面：
 *   R1 禁回收站（对应裁定 no-recycle-bin）
 *   R2 产物登记（对应"产出用户没要求的文件"）
 *   R3 文体声明（对应把核验数字写进"材料方法"正文）
 *   R4 交接前置（对应整会话没读 .ccm/PROGRESS.md 就一路写）
 * 另有 fail-open（策略缺失/字段缺失一律不拦）与 glob 语义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactGuard, globToRe, readKey } from "../lib/artifactguard.js";

/** 造一个临时项目：cwd = <root>/proj，策略文件在 <root>/policy.json。 */
async function setup(artifact, existing = [], actions = [{ command: "registered-cmd", files: [] }]) {
  const root = await mkdtemp(join(tmpdir(), "ag-"));
  const cwd = join(root, "proj");
  await mkdir(cwd, { recursive: true });
  const policyPath = join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify({ version: 1, protect: ["nothing-protected"], actions, artifact }), "utf8");
  for (const rel of existing) {
    const p = join(cwd, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "existing", "utf8");
  }
  const g = createArtifactGuard({ policyPath });
  const exec = (name, args) => ({ name, arguments: args, agent: { session: { header: { cwd } } } });
  return { g, cwd, policyPath, exec, root };
}
const NO_READS = new Set();

test("R1 禁回收站：把文件移动到垃圾/回收站类目录 ⇒ 拦", async () => {
  const { g, exec } = await setup({ noRecycleBin: true });
  const r = await g.pre(exec("pwsh", { command: "Move-Item -LiteralPath 'D:/proj/a.md' -Destination 'D:/proj/_trash/'" }), "s", NO_READS);
  assert.equal(r?.kind, "deny");
  assert.match(r.reason, /R1/);
  const r2 = await g.pre(exec("bash", { command: "mv a.md .trash/" }), "s", NO_READS);
  assert.equal(r2?.kind, "deny");
});

test("R1 对照面：彻底删除、以及移到非回收站路径 ⇒ 放行", async () => {
  const { g, exec } = await setup({ noRecycleBin: true });
  assert.equal(await g.pre(exec("pwsh", { command: "Remove-Item -LiteralPath 'D:/proj/a.md' -Recurse -Force" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Move-Item a.md b.md" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("pwsh", { command: "Move-Item a.md D:/proj/keep/" }), "s", NO_READS), null);
});

test("R2 产物登记：项目内新建未登记文件 ⇒ 拦；allowNew / scratch 命中 ⇒ 放行", async () => {
  const art = { allowNew: ["analysis_set/*.tsv"], scratch: ["tmp/**"] };
  const { g, exec } = await setup(art);
  const bad = await g.pre(exec("write", { file_path: "chikv1011/ALIGNMENT.md", content: "# x" }), "s", NO_READS);
  assert.equal(bad?.kind, "deny");
  assert.match(bad.reason, /R2/);
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/new.tsv", content: "a\tb" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("write", { file_path: "tmp/scratch.md", content: "# x" }), "s", NO_READS), null);
});

test("R2 对照面：覆盖**已存在**的文件不算新建 ⇒ 放行；项目外路径不判", async () => {
  const { g, exec } = await setup({ allowNew: [] }, ["chikv1011/README.md"]);
  assert.equal(await g.pre(exec("write", { file_path: "chikv1011/README.md", content: "# 改" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("write", { file_path: "C:/Windows/Temp/x.md", content: "# x" }), "s", NO_READS), null);
});

test("R3 文体声明：命中 genrePaths 且无 genre 行 ⇒ 拦；声明合法文体 ⇒ 放行；非法文体 ⇒ 拦", async () => {
  const { g, exec } = await setup({ genrePaths: ["**/METHODS*.md"], allowNew: ["METHODS.md", "chikv1011/METHODS.md"] });
  const noGenre = await g.pre(exec("write", { file_path: "METHODS.md", content: "# 材料方法\n本研究……" }), "s", NO_READS);
  assert.equal(noGenre?.kind, "deny");
  assert.match(noGenre.reason, /R3/);
  assert.equal(await g.pre(exec("write", { file_path: "METHODS.md", content: "# 材料方法\ngenre: methods\n……" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("write", { file_path: "chikv1011/METHODS.md", content: "genre: runbook\n……" }), "s", NO_READS), null);
  const bogus = await g.pre(exec("write", { file_path: "METHODS.md", content: "genre: 随便写\n……" }), "s", NO_READS);
  assert.equal(bogus?.kind, "deny");
});

test("R4 交接前置：未**完整读取**（绑定内容哈希）时，write 与已登记动作被拦；读过后放行", async () => {
  const { g, cwd, exec } = await setup({ requireReads: [".ccm/PROGRESS.md"], allowNew: ["analysis_set/*.tsv"] }, [".ccm/PROGRESS.md"], [{ command: "registered-cmd", files: [] }]);
  const w = await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", NO_READS);
  assert.equal(w?.kind, "deny");
  assert.match(w.reason, /R4/);
  const shellReg = await g.pre(exec("pwsh", { command: "registered-cmd" }), "s", NO_READS);
  assert.equal(shellReg?.kind, "deny");
  // 未登记的 shell 命令不在此列（否则会卡死常规工作）
  assert.equal(await g.pre(exec("pwsh", { command: "Get-Date" }), "s", NO_READS), null);
  // 只给路径（没有内容哈希）**不算**证据 —— 外部评审指出的"只查哈希/只看存在"绕过口
  const p = join(cwd, ".ccm", "PROGRESS.md");
  assert.equal((await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", new Set([p])))?.kind, "deny");
  // 绑定内容哈希 ⇒ 放行
  const sha = createHash("sha256").update(await readFile(p)).digest("hex");
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", new Set([readKey(p, sha)])), null);
});

test("R4 对照面：requireReads 指向的文件不存在 ⇒ 放行（无对象可读，不许卡死）", async () => {
  const { g, exec } = await setup({ requireReads: [".ccm/PROGRESS.md"], allowNew: ["analysis_set/*.tsv"] });
  assert.equal(await g.pre(exec("write", { file_path: "analysis_set/x.tsv", content: "a" }), "s", NO_READS), null);
});

test("fail-open：策略缺失、无 artifact 段、非受管工具 ⇒ 一律 null", async () => {
  const { g, exec, policyPath } = await setup({ noRecycleBin: true });
  const gone = createArtifactGuard({ policyPath: policyPath + ".missing" });
  assert.equal(await gone.pre(exec("write", { file_path: "x.md", content: "y" }), "s", NO_READS), null);
  const { g: g2, exec: e2 } = await setup(null);
  assert.equal(await g2.pre(e2("write", { file_path: "x.md", content: "y" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("read", { file_path: "x.md" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("skill", { name: "pdf" }), "s", NO_READS), null);
});

test("globToRe：`**/` 可匹配零层目录；`*` 不跨目录", () => {
  assert.equal(globToRe("**/METHODS*.md").test("METHODS.md"), true);
  assert.equal(globToRe("**/METHODS*.md").test("chikv1011/METHODS.md"), true);
  assert.equal(globToRe("**/METHODS*.md").test("chikv1011/sub/METHODS.md"), true);
  assert.equal(globToRe("analysis_set/*.tsv").test("analysis_set/a.tsv"), true);
  assert.equal(globToRe("analysis_set/*.tsv").test("analysis_set/sub/a.tsv"), false);
});

test("R5 参数闸：受管工具的线程取值必须等于有效裁定；重复与夹带都拦", async () => {
  const guard = { name: "线程数", tool: "iqtree3|mafft", regex: "-T\\s+(\\d+)|--threads?\\s+(\\d+)", allowed: ["32"] };
  const { g, exec } = await setup({ paramGuards: [guard] });
  assert.equal((await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 64 -m MFP" }), "s", NO_READS))?.kind, "deny");
  assert.equal(await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 32 -m MFP" }), "s", NO_READS), null);
  assert.equal(await g.pre(exec("pwsh", { command: "mafft --auto --thread 32 in.fa" }), "s", NO_READS), null);
  // 外部评审点名的两条绕过路径
  assert.equal((await g.pre(exec("pwsh", { command: "iqtree3 -s aln.fa -T 32 -T 64" }), "s", NO_READS))?.kind, "deny");
  assert.equal((await g.pre(exec("pwsh", { command: "echo \"-T 32\"; iqtree3 -s aln.fa -T 64" }), "s", NO_READS))?.kind, "deny");
  // 别的工具的同名参数不套用本规则
  assert.equal(await g.pre(exec("pwsh", { command: "other-tool -T 64" }), "s", NO_READS), null);
  // 未声明 require 时，缺参数不拦
  assert.equal(await g.pre(exec("pwsh", { command: "mafft --auto in.fa" }), "s", NO_READS), null);
});
