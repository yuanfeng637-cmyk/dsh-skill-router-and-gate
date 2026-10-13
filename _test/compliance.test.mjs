import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompliance, sha256, bioCommand } from "../lib/compliance.js";

const dir = mkdtempSync(join(tmpdir(), "skillgate-compliance-"));
const policyPath = join(dir, "policy.json");
const input = join(dir, "input.fa");
const output = join(dir, "output.fa");
const memory = join(dir, "MEMORY.md");
const quote = "对齐和建树都使用16线程自动探索";
const command = "python run-analysis.py --threads 16 --max-length 12000";
const verify = "python validate-sample.py";
const success = (text) => ({ isError: false, content: [{ type: "text", text }] });
const exec = (text, sid = "A") => ({ name: "pwsh", arguments: { command: text },
  agent: { id: sid, session: { header: { cwd: dir } } } });
function setup({ expensive = true, receipt = false } = {}) {
  writeFileSync(input, ">x\nACGN\n");
  writeFileSync(memory, quote);
  const policy = { version: 1, protect: ["run-analysis"], actions: [{ command,
    files: [{ path: input, role: "input", sha256: sha256(readFileSync(input)) },
      ...(receipt ? [{ path: output, role: "output" }] : [])],
    rulings: [{ path: memory, sha256: sha256(quote), quote, required: ["--threads 16", "--max-length 12000"] }],
    estimates: { wallSeconds: expensive ? 600 : 1, cpuSeconds: 0, outputBytes: 0, networkRequests: 0 },
    hypothesis: "小样本解析保持 IUPAC 且无 GN 前缀", abortWhen: "字符数或样本长度不符即中止",
    assertions: [{ command: verify, outputIncludes: "columns: id,length; IUPAC=OK; prefix=OK" }] }] };
  process.env.DSH_SKILL_GATE_POLICY = policyPath;
  writeFileSync(policyPath, JSON.stringify(policy));
  const auditPath = join(dir, `audit-${Math.random()}.ndjson`);
  let clock = 100000;
  const gate = createCompliance({ auditPath, version: 18, now: () => clock });
  return { gate, policy, auditPath, tick: () => { clock += 1800001; }, save: () => writeFileSync(policyPath, JSON.stringify(policy)) };
}
async function proof(gate, sid = "A", result = success("columns: id,length; IUPAC=OK; prefix=OK"), decision = { kind: "accept" }) {
  assert.equal(await gate.pre(exec(verify, sid), sid, new Set()), null);
  await gate.post(exec(verify, sid), result, decision, sid);
}
const deny = async (gate, text = command, sid = "A") => {
  const d = await gate.pre(exec(text, sid), sid, new Set());
  assert.equal(d?.kind, "deny"); return d.reason;
};

test("默认：加载生信技能后需先前成功帮助输出；同调用追加帮助不能解锁", async () => {
  delete process.env.DSH_SKILL_GATE_POLICY;
  const g = createCompliance({ auditPath: join(dir, "help.ndjson"), version: 18 });
  const loaded = new Set(["bioinformatics-toolkit"]);
  assert.equal((await g.pre(exec("mafft --auto in.fa"), "A", loaded))?.kind, "deny");
  assert.equal(await g.pre(exec("mafft --help"), "A", loaded), null);
  await g.post(exec("mafft --help"), success("Usage: mafft --auto input"), { kind: "block" }, "A");
  assert.equal((await g.pre(exec("mafft --auto in.fa"), "A", loaded))?.kind, "deny");
  assert.equal(await g.pre(exec("mafft --help"), "A", loaded), null);
  await g.post(exec("mafft --help"), success("Usage: mafft --auto input"), { kind: "accept" }, "A");
  assert.equal(await g.pre(exec("mafft --auto in.fa"), "A", loaded), null);
  assert.equal((await g.pre(exec("mafft --auto in.fa", "B"), "B", loaded))?.kind, "deny");
  g.drop("A");
  assert.equal((await g.pre(exec("mafft --auto in.fa"), "A", loaded))?.kind, "deny");
});
test("帮助语法窄匹配：搜索、字符串、版本、绝对路径与复合 shell 边界", () => {
  assert.equal(bioCommand("Write-Output 'mafft --help'"), null);
  assert.equal(bioCommand("mafft --help; mafft --auto x"), null);
  assert.equal(bioCommand("ssh host mafft --auto x"), null);
  assert.equal(bioCommand("C:/tools/mafft.exe --auto x"), null);
  assert.equal(bioCommand("IQTREE3 --version").probe, true);
});
test("首次受管动作缺前置验证即拦，成功输出才解锁", async () => {
  const { gate } = setup();
  assert.match(await deny(gate), /成功前置证据/);
  await proof(gate, "A", success("wrong columns"));
  await deny(gate);
  await proof(gate);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
});
test("失败/下游 block 不提供依从证据", async () => {
  const { gate } = setup();
  await proof(gate, "A", { ...success("columns: id,length; IUPAC=OK; prefix=OK"), isError: true });
  await deny(gate);
  await proof(gate, "A", success("columns: id,length; IUPAC=OK; prefix=OK"), { kind: "block" });
  await deny(gate);
});
test("同会话、TTL、输入 sha、策略摘要全部绑定", async () => {
  const { gate, tick, policy, save } = setup();
  await proof(gate);
  await deny(gate, command, "B");
  tick(); await deny(gate);
  await proof(gate);
  writeFileSync(input, ">x\nGNACG\n");
  assert.match(await deny(gate), /哈希不符/);
  policy.actions[0].files[0].sha256 = sha256(readFileSync(input)); save();
  await deny(gate); // changing the policy cannot launder old evidence
});
test("验证执行期间改变输入，不能登记证据", async () => {
  const { gate } = setup();
  assert.equal(await gate.pre(exec(verify), "A", new Set()), null);
  writeFileSync(input, "changed");
  await gate.post(exec(verify), success("columns: id,length; IUPAC=OK; prefix=OK"), { kind: "accept" }, "A");
  writeFileSync(input, ">x\nACGN\n");
  await deny(gate);
});
test("裁定逐字固定：来源改动、线程漂移、阈值漂移均拒", async () => {
  const { gate } = setup(); await proof(gate);
  assert.match(await deny(gate, command.replace("16", "32")), /精确 command/);
  assert.match(await deny(gate, command.replace("12000", "12200")), /精确 command/);
  writeFileSync(memory, quote + "\nagent 自选32");
  assert.match(await deny(gate), /原文\/来源改变/);
});
test("即使重新登记错误 command，也不能违背固定的裁定映射", async () => {
  const { gate, policy, save } = setup();
  policy.actions[0].command = command.replace("16", "32"); save(); await proof(gate);
  assert.match(await deny(gate, policy.actions[0].command), /不符合用户裁定/);
});
test("四类估计阈值各自要求假设、验证、中止条件；缺估计拒绝", async () => {
  for (const [key, limit] of Object.entries({ wallSeconds: 300, cpuSeconds: 1800, outputBytes: 104857600, networkRequests: 100 })) {
    const { gate, policy, save } = setup({ expensive: false });
    policy.actions[0].estimates[key] = limit; policy.actions[0].hypothesis = ""; save();
    assert.match(await deny(gate), /昂贵动作/);
  }
  const { gate, policy, save } = setup(); delete policy.actions[0].estimates.cpuSeconds; save();
  assert.match(await deny(gate), /estimates/);
});
test("结果回执记录真实片段、输入和产物 SHA256；旧输出不可算本次产物", async () => {
  const { gate, auditPath } = setup({ receipt: true });
  await proof(gate); assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  writeFileSync(output, "new artifact " + Math.random());
  await gate.post(exec(command), success("records=1; IUPAC=OK"), { kind: "accept" }, "A");
  const rows = readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse);
  const receipt = rows.at(-1);
  assert.equal(receipt.receiptComplete, true);
  assert.equal(receipt.artifacts[0].sha256, sha256(readFileSync(output)));
  assert.equal(receipt.sources[0].sha256, sha256(readFileSync(input)));
  assert.match(receipt.outputExcerpt, /records=1/);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  await gate.post(exec(command), success("done"), { kind: "accept" }, "A");
  const last = JSON.parse(readFileSync(auditPath, "utf8").trim().split("\n").at(-1));
  assert.equal(last.receiptComplete, false); assert.match(last.receiptError, /产物未更新/);
});
test("旧脚本/引用哈希不符硬拒；缺完整来源标注告警", async () => {
  const { gate, policy, save, auditPath } = setup();
  policy.actions[0].files[0].role = "script";
  policy.actions[0].estimates.wallSeconds = 1; save(); await proof(gate);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  assert.match(readFileSync(auditPath, "utf8"), /缺版本/);
  gate.cancel(exec(command), "A");
  writeFileSync(input, "old broken script"); assert.match(await deny(gate), /哈希不符/);
});
test("策略损坏/不存在、审计 IO 失败均不能静默解锁；无策略不误伤普通动作", async () => {
  const { gate } = setup(); writeFileSync(policyPath, "bad JSON"); await deny(gate);
  process.env.DSH_SKILL_GATE_POLICY = join(dir, "missing.json"); await deny(gate);
  delete process.env.DSH_SKILL_GATE_POLICY;
  assert.equal(await gate.pre(exec("Get-ChildItem"), "A", new Set()), null);
  const g = createCompliance({ auditPath: join(dir, "missing-parent", "audit") });
  assert.equal(await g.pre(exec("mafft --help"), "A", new Set()), null);
  await assert.rejects(g.post(exec("mafft --help"), success("Usage: mafft --auto"), { kind: "accept" }, "A"));
  assert.equal((await g.pre(exec("mafft --auto x"), "A", new Set(["bioinformatics-toolkit"])))?.kind, "deny");
});
test("下游拒绝后 cancel 清 pending；重复并发拒；匿名证明拒", async () => {
  const { gate } = setup(); await proof(gate);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  assert.match(await deny(gate), /尚未返回/);
  gate.cancel(exec(command), "A");
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  assert.match(await deny(gate, command, "__noagent__"), /agent.id/);
});
test("后台启动通知不能算完成或验证证据", async () => {
  const { gate } = setup();
  await proof(gate, "A", success("Script running with cell ID 1\ncolumns: id,length; IUPAC=OK; prefix=OK"));
  await deny(gate);
});
test("多个动作共享一次验证分别绑定各自输入，不重复拼接", async () => {
  const { gate, policy, save } = setup();
  policy.actions.push({ ...policy.actions[0], command: command + " --second" }); save();
  await proof(gate);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  assert.equal(await gate.pre(exec(command + " --second"), "A", new Set()), null);
});
test("策略保护 mafft 时仍允许独立 help/version，避免把解锁路径挡死", async () => {
  const { gate, policy, save } = setup(); policy.protect.push("mafft"); save();
  assert.equal(await gate.pre(exec("mafft --help"), "A", new Set()), null);
  assert.equal(await gate.pre(exec("mafft --version"), "A", new Set()), null);
});
test("带完整标注的旧引用超过24小时仍告警，来源信息写入审计", async () => {
  const { gate, policy, save, auditPath } = setup({ expensive: false });
  Object.assign(policy.actions[0].files[0], { role: "reference", version: "v1", generatedAt: "2020-01-01T00:00:00Z",
    inputs: [{ path: "raw.gb", sha256: "a".repeat(64) }] }); save(); await proof(gate);
  assert.equal(await gate.pre(exec(command), "A", new Set()), null);
  const last = JSON.parse(readFileSync(auditPath, "utf8").trim().split("\n").at(-1));
  assert.match(last.warnings[0], /超过24小时或时间在未来/);
  assert.equal(last.files[0].version, "v1");
});
