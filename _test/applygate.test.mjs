/**
 * apply() 级闸门测试（v14.4）：`npm test`（= `node --test --import ./_test/resolve-stub.mjs`）
 *
 * 起因（第二轮外部复查的覆盖缺口）：单测只到纯函数/纯容器，没人驱动 `apply()` 的三个 waterfall。
 * 本文件用**最小假 ctx** 真正把它跑起来。要点（都踩过）：
 *   · 代码访问服务有**两种**方式：`ctx.skills.snapshot(...)`（顶层服务）与 `ctx.get("llm"|"commands"|"agentDefaultModel")`
 *     ⇒ 假 ctx 两者都要给（只给 get 会让目录永远为空，症状是"该放行的也被拒"）。
 *   · waterfall 的 `next()` **终点必须返回该事件的合法终值**：pre-execute ⇒ {kind:'allow'}、
 *     post-execute ⇒ {kind:'accept'}、pre-step ⇒ {messages:[]}。
 *   · 可**后注册**监听器（模拟排在后面的插件），用于验证"下游 block ⇒ 不解锁"。
 *   · 账本指向临时文件（`DSH_SKILL_GATE_TRACE=<路径>`），不碰真账本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "skillgate-apply-"));
const traceFile = join(dir, "trace.ndjson");
process.env.DSH_SKILL_GATE_TRACE = traceFile;

// 没带 --import（例如直接 `node --test`）时，`@deepseek-ai/dsh-llm` 解析不到 ⇒ 优雅跳过而不是整套失败
let apply = null;
let importError = null;
try {
  ({ apply } = await import("../lib/index.js"));
} catch (error) {
  importError = error;
  console.log("  ℹ applygate：跳过（请用 `npm test`，它带 --import ./_test/resolve-stub.mjs）：" + error.code);
}
const T = (name, fn) => (importError ? test.skip(name) : test(name, fn));

let snapshotSkills = [];
const mkSkill = (name) => ({ name, invocation: { modelInvocable: true }, description: "d " + name, whenToUse: "when " + name });

function harness() {
  const handlers = new Map();
  const ctx = {
    on: (name, fn) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {};
    },
    skills: { snapshot: async () => ({ skills: snapshotSkills, complete: true }) },
    get: () => undefined,
  };
  apply(ctx);

  const chain = (name, args, terminal) => {
    const list = handlers.get(name) ?? [];
    const run = (i) => (i >= list.length ? terminal : list[i](...args, () => run(i + 1)));
    return run(0);
  };
  return {
    register: (name, fn) => ctx.on(name, fn),
    preStep: (agent, text = "读一下这个 xlsx") => {
      // ⚠ waterfall 的 next() 在本事件里**返回本轮领取的消息**，代码用 `decision.messages ?? messages` 取用户文本
      // ⇒ 终点必须把消息**原样透传**；返回 `{messages: []}` 会让 query 为空、pre-step 在建立目录前就早退。
      const messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }];
      return chain("agent/pre-step", [{ agent, messages, step: 1, signal: new AbortController().signal }], { messages });
    },
    preExecute: (exec) => chain("tools/pre-execute", [exec], { kind: "allow" }),
    postExecute: (exec, result) => chain("tools/post-execute", [exec, result], { kind: "accept" }),
    disposed: (agent) => chain("agent/disposed", [{ agent }], undefined),
  };
}

const agentOf = (id) => ({ id, session: { header: { cwd: "C:/tmp" } } });
const cmd = (sid, command) => ({ name: "pwsh", arguments: { command }, agent: { id: sid } });
const skillExec = (sid, name) => ({ name: "skill", arguments: { name }, agent: { id: sid } });
const XLSX = 'python -c "import openpyxl; openpyxl.load_workbook(p)"';
const PDF = 'python -c "import fitz; fitz.open(p)"';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const why = (d) => `实际=${d?.kind} skill=${d?.skill ?? "-"} reason=${String(d?.reason ?? "").slice(0, 90)}`;

/** 等**匹配条件的**行出现（不能只等"任意 gate 行"：早先用例的行会先到）。 */
async function gateRows(pred, timeoutMs = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = existsSync(traceFile)
      ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const hit = rows.filter((r) => String(r.stage ?? "").startsWith("gate-") && pred(r));
    if (hit.length) return hit;
    await sleep(20);
  }
  return [];
}

T("apply()：目录按会话 —— A 的目录有 excel ⇒ 拒；B 的目录没有 ⇒ 兜底① 放行", async () => {
  const h = harness();
  snapshotSkills = [mkSkill("office-xlsx"), mkSkill("pdf"), mkSkill("tabular-read")];
  await h.preStep(agentOf("sess-A"));
  snapshotSkills = [mkSkill("pdf")]; // B 的目录里**没有** office-xlsx
  await h.preStep(agentOf("sess-B"));

  const a = await h.preExecute(cmd("sess-A", XLSX));
  assert.equal(a.kind, "deny", "A 的目录里确有 office-xlsx 且未加载 ⇒ 应拒（" + why(a) + "）");

  const b = await h.preExecute(cmd("sess-B", XLSX));
  assert.equal(b.kind, "allow", "B 的目录里没有该技能 ⇒ 兜底① 放行（" + why(b) + "）");
});

T("apply()：只有 skill 的 post-execute「被接受且成功」才解锁", async () => {
  const h = harness();
  snapshotSkills = [mkSkill("office-xlsx")];
  await h.preStep(agentOf("sess-C"));
  const sk = skillExec("sess-C", "office-xlsx");

  await h.postExecute(sk, { isError: true });
  const afterFail = await h.preExecute(cmd("sess-C", XLSX));
  assert.equal(afterFail.kind, "deny", "失败的加载不能解锁（" + why(afterFail) + "）");

  await h.postExecute(sk, { isError: false });
  const afterOk = await h.preExecute(cmd("sess-C", XLSX));
  assert.equal(afterOk.kind, "allow", "接受且成功 ⇒ 解锁（" + why(afterOk) + "）");
});

T("apply()：成功但被下游监听器 block ⇒ 不解锁（登记判在 next() 之后）", async () => {
  const h = harness();
  snapshotSkills = [mkSkill("office-xlsx")];
  await h.preStep(agentOf("sess-BLK"));
  h.register("tools/post-execute", async (exec, result, next) => {
    await next();
    return { kind: "block", feedback: [{ type: "text", text: "downstream blocked" }] };
  });
  await h.postExecute(skillExec("sess-BLK", "office-xlsx"), { isError: false });
  const r = await h.preExecute(cmd("sess-BLK", XLSX));
  assert.equal(r.kind, "deny", "被下游 block ⇒ 不算加载成功 ⇒ 仍拒（" + why(r) + "）");
});

T("apply()：账本 gate-* 行带 session + gateLoaded（v14.4 新增）", async () => {
  const h = harness();
  snapshotSkills = [mkSkill("office-xlsx"), mkSkill("pdf")];
  await h.preStep(agentOf("sess-T"));
  await h.postExecute(skillExec("sess-T", "office-xlsx"), { isError: false });
  const r = await h.preExecute(cmd("sess-T", PDF));
  assert.equal(r.kind, "deny", "pdf 未加载 ⇒ 应拒（" + why(r) + "）");
  const rows = await gateRows((x) => x.session === "sess-T" && x.stage === "gate-deny");
  assert.ok(rows.length >= 1, "应有 sess-T 的 gate-deny 行");
  const last = rows[rows.length - 1];
  assert.equal(last.skill, "pdf");
  assert.deepEqual(last.gateLoaded, ["office-xlsx"], "该行应显示闸门当时认为已加载 office-xlsx");
});

T("apply()：agent/disposed 清空该会话状态（连目录一起 ⇒ 回到「目录未知」）", async () => {
  const h = harness();
  snapshotSkills = [mkSkill("office-xlsx")];
  await h.preStep(agentOf("sess-E"));
  await h.postExecute(skillExec("sess-E", "office-xlsx"), { isError: false });
  const unlocked = await h.preExecute(cmd("sess-E", XLSX));
  assert.equal(unlocked.kind, "allow", "先确认已解锁（" + why(unlocked) + "）");
  h.disposed(agentOf("sess-E"));
  const afterDrop = await h.preExecute(cmd("sess-E", XLSX));
  assert.equal(afterDrop.kind, "deny", "清理后目录也没了 ⇒ 按未知目录处理仍然拦（" + why(afterDrop) + "）");
  const again = await h.postExecute(skillExec("sess-E", "office-xlsx"), { isError: false });
  assert.equal(again.kind, "accept", "post 链应返回 accept 终值");
});

T("apply()：目录未知时仍然拦（钉住真实行为；status 文案已按此更正）", async () => {
  const h = harness();
  const r = await h.preExecute(cmd("sess-NOCAT", XLSX)); // 故意不跑 pre-step ⇒ 无目录快照
  assert.equal(r.kind, "deny", "没有目录快照时不享受兜底① ⇒ 仍拦（拦满 maxDeny 即放行）（" + why(r) + "）");
  assert.match(String(r.reason), /office-xlsx/);
});



