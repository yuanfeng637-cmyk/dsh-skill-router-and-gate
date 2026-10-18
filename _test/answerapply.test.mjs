// Purpose: exercise registered hooks, not just validators; npm test supplies host exports stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let apply, markAgentLoopRequest, BlockAssembler, loadError;
try {
  ({ apply } = await import("../lib/index.js"));
  ({ markAgentLoopRequest, BlockAssembler } = await import("@deepseek-ai/dsh-llm"));
} catch (error) { loadError = error; }
const T = loadError ? test.skip : test;
const temp = mkdtempSync(join(tmpdir(), "answergate-apply-"));
process.env.DSH_SKILL_GATE_TRACE = join(temp, "trace.ndjson");
process.env.DSH_SKILL_GATE_COMPLIANCE_TRACE = join(temp, "compliance.ndjson");
delete process.env.DSH_SKILL_GATE_POLICY;
const user = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "请核对" }] };
const tool = { role: "tool", toolCallId: "actual", isError: false, content: [{ type: "text", text: "116 columns" }] };
function harness() {
  const handlers = new Map();
  apply({ on(name, fn) { const a = handlers.get(name) ?? []; a.push(fn); handlers.set(name, a); },
    skills: { snapshot: async () => ({ skills: [] }) }, get() {} });
  return (event, args, terminal) => {
    const fns = handlers.get(event) ?? [];
    const run = (i) => i < fns.length ? fns[i](...args, () => run(i + 1)) : terminal;
    return run(0);
  };
}
async function* chunks(text) {
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
async function result(stream) {
  const a = new BlockAssembler(); for await (const c of stream) a.push(c);
  return a.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
T("apply llm/stream blocks loop-owned final answer before consumer; sourced answer passes", async () => {
  const dispatch = harness();
  const run = (text, msgs, sessionId = "a") => result(dispatch("llm/stream", [markAgentLoopRequest({ sessionId, messages: msgs })], chunks(text)));
  assert.match(await run("全部相同", [user]), /回答闸拦截/);
  assert.equal(await run("全部相同，116 列", [user, tool]), "全部相同，116 列");
  assert.equal(await run("全部相同，116 列", [user]), "全部相同，116 列");
  assert.match(await run("全部相同，116 列", [user], "without-evidence"), /回答闸拦截/);
});
T("apply isolates simultaneous request evidence and never gates judge/internal LLM calls", async () => {
  const d = harness();
  const [a, b, internal] = await Promise.all([
    result(d("llm/stream", [markAgentLoopRequest({ sessionId: "a", messages: [user, tool] })], chunks("116"))),
    result(d("llm/stream", [markAgentLoopRequest({ sessionId: "b", messages: [user] })], chunks("116 列"))),
    result(d("llm/stream", [{ sessionId: "a", messages: [user] }], chunks("999"))),
  ]);
  assert.equal(a, "116"); assert.match(b, /回答闸拦截/); assert.equal(internal, "999");
});
T("apply turn entry injects machine syntax even when catalog is empty; tool-only steps do not", async () => {
  const d = harness();
  const args = { agent: { id: "a" }, messages: [user] };
  const out = await d("agent/pre-step", [args], { kind: "enter", messages: [user] });
  assert.equal(out.messages.filter((m) => m.source?.kind === "answer-gate").length, 1);
  assert.match(out.messages.at(-1).content[0].text, /失败证据:toolCallId/);
  const empty = await d("agent/pre-step", [{ ...args, messages: [] }], { kind: "enter", messages: [] });
  assert.deepEqual(empty.messages, []);
});
T("apply answer-specific switch and master switch respect existing administration", async () => {
  try {
    process.env.DSH_ANSWER_GATE = "0";
    const d = harness();
    assert.equal(await result(d("llm/stream", [markAgentLoopRequest({ messages: [user] })], chunks("999"))), "999");
    delete process.env.DSH_ANSWER_GATE;
    process.env.DSH_SKILL_GATE = "0";
    const off = harness();
    assert.equal(await result(off("llm/stream", [markAgentLoopRequest({ messages: [user] })], chunks("999"))), "999");
  } finally { delete process.env.DSH_ANSWER_GATE; delete process.env.DSH_SKILL_GATE; }
});

T("apply warn/off modes and per-session exemption reach the real stream hook", async () => {
  const old = process.env.DSH_ANSWER_GATE;
  try {
    const d = harness();
    const run = (sessionId, text) => result(d("llm/stream", [markAgentLoopRequest({ sessionId,
      messages: [{ ...user, content: [{ type: "text", text }] }] })], chunks("999 列")));
    process.env.DSH_ANSWER_GATE = "warn";
    const warned = await run("warn", "核对");
    assert.match(warned, /^999 列/); assert.match(warned, /类型=数字无出处/); assert.doesNotMatch(warned, /回答闸拦截/);
    process.env.DSH_ANSWER_GATE = "off";
    assert.equal(await run("off", "核对"), "999 列");
    process.env.DSH_ANSWER_GATE = "block";
    assert.equal(await run("waiver", "本次免检"), "999 列");
    assert.match(await run("waiver", "本次免检"), /回答闸拦截/);
    assert.match(await run("another", "核对"), /回答闸拦截/);
  } finally {
    if (old === undefined) delete process.env.DSH_ANSWER_GATE;
    else process.env.DSH_ANSWER_GATE = old;
  }
});

T("apply block preserves executable tool blocks and provider finish reason", async () => {
  const d = harness(), input = [
    { type: "text-delta", index: 0, text: "999 列" },
    { type: "block-end", index: 0, block: { type: "text", text: "999 列" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "block-end", index: 1, block: { type: "tool-call", id: "read", name: "read", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
  async function* stream() { yield* input; }
  const out = [];
  for await (const c of d("llm/stream", [markAgentLoopRequest({ sessionId: "tools", messages: [user] })], stream())) out.push(c);
  assert.deepEqual(out.filter((c) => c.index === 1), input.filter((c) => c.index === 1));
  assert.equal(out.at(-1).reason.kind, "tool-calls");
  const a = new BlockAssembler(); for (const c of out) a.push(c);
  assert.equal(a.blocks().some((b) => b.type === "tool-call" && b.id === "read"), true);
});
