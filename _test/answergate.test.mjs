import { test } from "node:test";
process.env.DSH_ANSWER_GATE ??= "block"; // v32: default off; tests opt in
import assert from "node:assert/strict";
import { collectAnswerEvidence, checkAnswer, guardAnswerStream, numbersOf, createAnswerGateState, answerGateMode } from "../lib/answergate.js";
const user = (text = "compare") => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const tool = (id, text, isError = false) => ({ role: "tool", toolCallId: id, isError, content: [{ type: "text", text }] });
const call = (id, name, args) => ({ role: "assistant", content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }] });
const evidence = (...msgs) => collectAnswerEvidence([user(), ...msgs]);
const rules = (text, e = evidence()) => checkAnswer(text, e).issues.map((i) => i.rule);
const assemble = (chunks) => {
  const blocks = new Map();
  for (const c of chunks) {
    if (c.type === "text-delta" && !blocks.get(c.index)?.closed) blocks.set(c.index, { type: "text", text: (blocks.get(c.index)?.text ?? "") + c.text });
    if (c.type === "block-end") blocks.set(c.index, { ...c.block, closed: true });
  }
  return [...blocks.values()];
};
async function* source(chunks) { yield* chunks; }
const chunksOf = (text) => [{ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text },
  { type: "block-end", index: 0, block: { type: "text", text } }, { type: "finish", reason: { kind: "stop" } }];
const collect = async (s) => { const a = []; for await (const c of s) a.push(c); return a; };
const run = (text, opts = {}) => collect(guardAnswerStream(source(chunksOf(text)), { assemble, ...opts }));
const outputText = (chunks) => assemble(chunks).filter((b) => b.type === "text").map((b) => b.text).join("\n");

test("numeric tokens preserve exact signs, grouping, exponents and international digits", () => {
  assert.deepEqual(numbersOf("-1.2 1,000 1e-3 １１６ ١١٦ ۱۱۶").map((n) => n.value), ["-1.2", "1000", "1e-3", "116", "116", "116"]);
  assert.deepEqual(rules("116 列", evidence(tool("a", "2116"))), ["number-source"]);
  assert.deepEqual(rules("1,000", evidence(tool("a", "1000"))), []);
  assert.deepEqual(rules("-3", evidence(tool("a", "3"))), ["number-source"]);
});
test("only tool outputs supply provenance, never assistant, user or arguments", () => {
  const e = evidence(user("116"), call("a", "read", { path: "116.txt" }), { role: "assistant", content: [{ type: "text", text: "116" }] });
  assert.deepEqual(rules("116 列", e), ["number-source"]);
  assert.equal(checkAnswer("116 列", evidence(tool("actual", "116"))).matches[0].toolCallId, "actual");
});
test("unverified marker covers exactly the next number", () => {
  assert.deepEqual(rules("[未验]116"), []);
  assert.deepEqual(rules("[未验]116 和 3"), ["number-source"]);
  assert.deepEqual(rules("[未验] 估计 116"), ["number-source"]);
});
test("all user turns contribute evidence, bounded by most recent result count", () => {
  const msgs = [user(), tool("old", "116"), ...Array.from({ length: 8 }, () => user()), tool("new", "7")];
  assert.deepEqual(rules("116 列", collectAnswerEvidence(msgs)), []);
  assert.deepEqual(rules("116 列", collectAnswerEvidence(msgs, { maxResults: 1 })), ["number-source"]);
  assert.equal(collectAnswerEvidence(msgs, { maxResults: -1 }).maxResults, 1000);
});
test("session evidence survives truncation, isolates sessions and respects LRU/result caps", () => {
  const state = createAnswerGateState({ maxSessions: 2, maxResults: 1 });
  state("a", [user(), tool("old", "116")]);
  assert.deepEqual(rules("116 列", state("a", [user()]).evidence), []);
  assert.deepEqual(rules("116 列", state("b", [user()]).evidence), ["number-source"]);
  state("a", [user(), tool("new", "7")]);
  assert.deepEqual(rules("116 列", state("a", []).evidence), ["number-source"]);
  state("c", []); state("b", []);
  assert.deepEqual(rules("7 列", state("a", []).evidence), ["number-source"]);
});
test("code, inline code, paths, dates and versions have separate numeric exemptions", () => {
  for (const text of ["```js\nconst x=999; // 全部不可用\n```", "`999`", "C:\\work\\2026\\v27.js", "/tmp/999.txt", "./data/999.csv", "2026-10-17", "2026/10/17", "2026年10月17日", "v27", "版本号 27", "VERSION=27", "0.2.0-rc.2"]) assert.deepEqual(rules(text), [], text);
  assert.equal(checkAnswer("年份 2026", evidence()).issues[0].severity, "warn");
});
test("ambiguous Chinese words warn, ordinary absence does not imply capability denial", () => {
  for (const text of ["与原文一致", "全部资料已保留", "该接口不可用"]) assert.ok(checkAnswer(text, evidence()).issues.every((i) => i.severity === "warn"));
  assert.deepEqual(rules("没有改文件"), []);
  assert.equal(checkAnswer("全部相同", evidence()).issues[0].severity, "block");
});
test("denominators accept colon, ratios, totals and immediate previous paragraph", () => {
  const e = evidence(tool("a", "116 3"));
  for (const d of ["分母=116", "(分母: 116 列)", "116 列", "116 条", "116 链", "116/116 相同", "共 116 项中的 3 项", "分母：１１６"]) {
    assert.deepEqual(rules("全部相同 " + d, e), [], d);
    assert.deepEqual(rules(d + "\n\n全部相同", e), [], d);
  }
  assert.ok(rules("分母=116\n\n说明\n\n全部相同", e).includes("denominator"));
  assert.ok(rules("全部相同\n\n116列", e).includes("denominator"));
  assert.ok(rules("全部相同 [未验]116列").includes("denominator"));
  assert.ok(rules("全部相同 分母=1.5", evidence(tool("a", "1.5"))).includes("denominator"));
});
const failures = () => [user(), call("a", "read", { path: "/a" }), tool("a", "ENOENT path missing", true), call("b", "shell", { command: "test-path /b" }), tool("b", "Access denied", true)];
const triple = "read /a：ENOENT path missing；shell test-path /b：Access denied";
test("failure evidence accepts triples without ids; local claims need one failed method", () => {
  const e = collectAnswerEvidence(failures());
  assert.deepEqual(rules("所有接口不可用；" + triple, e), []);
  assert.deepEqual(rules("所有接口不可用；" + triple + " [失败证据:a] [失败证据:b]", e), []);
  assert.deepEqual(rules("该接口不可用；read /a：ENOENT path missing", e), []);
  assert.ok(rules("所有接口不可用；read /a：ENOENT path missing", e).includes("unavailable-evidence"));
  assert.ok(rules("该接口不可用 [失败证据:a]", e).includes("unavailable-evidence"));
});
test("success, old failures, duplicate methods and anonymous failures cannot prove global unavailability", () => {
  const duplicate = failures(); duplicate[3] = call("b", "read", { path: "/a" });
  const success = failures(); success[4].isError = false;
  for (const msgs of [duplicate, success, [...failures(), user()], [user(), tool("a", "ENOENT", true)]]) assert.ok(rules("所有接口不可用；" + triple, collectAnswerEvidence(msgs)).includes("unavailable-evidence"));
});
test("warn appends actionable structured notice and preserves original body", async () => {
  const out = await run("116 列", { mode: "warn" });
  assert.equal(assemble(out)[0].text, "116 列");
  assert.match(outputText(out), /\[回答闸\] 类型=数字无出处 \| 命中=116 \| 片段=116 列 \| 建议=标\[未验\]或补工具输出/);
  assert.doesNotMatch(outputText(out), /回答闸拦截/);
});
test("default block handles hard counts while isolated numbers and common words warn", async () => {
  for (const text of ["116", "与原文一致", "该接口不可用"]) {
    const out = await run(text);
    assert.equal(assemble(out)[0].text, text); assert.doesNotMatch(outputText(out), /回答闸拦截/);
  }
  const out = await run("通过 116 项");
  assert.match(outputText(out), /回答闸拦截/);
  assert.notEqual(assemble(out)[0].text, "通过 116 项");
});
test("block preserves every tool chunk, usage and tool-call finish reason", async () => {
  const tools = [{ type: "block-start", index: 1, blockType: "tool-call" }, { type: "tool-call-delta", index: 1, arguments: "{}" },
    { type: "block-end", index: 1, block: { type: "tool-call", id: "x", name: "read", arguments: "{}" } }];
  const input = [...chunksOf("116 列").slice(0, -1), ...tools, { type: "usage", usage: { inputTokens: 10 } }, { type: "finish", reason: { kind: "tool-calls" }, replayState: { response: "stale" } }];
  const out = await collect(guardAnswerStream(source(input), { assemble }));
  assert.deepEqual(out.filter((c) => c.index === 1), tools);
  assert.equal(out.at(-1).reason.kind, "tool-calls"); assert.equal(out.some((c) => c.type === "usage"), true);
  assert.doesNotMatch(JSON.stringify(out), /stale/);
  assert.deepEqual(out.filter((c) => c.type === "block-start").map((c) => c.index), [0, 1]);
});
test("clean responses and promised streams retain exact raw chunks", async () => {
  const input = chunksOf("116 列");
  assert.deepEqual(await collect(guardAnswerStream(Promise.resolve(source(input)), { assemble, messages: [tool("a", "116")] })), input);
});
test("both live and assembled surfaces are checked even when contradictory", async () => {
  for (const [live, final] of [["999 列", "ok"], ["ok", "999 列"]]) {
    const input = [{ type: "text-delta", index: 0, text: live }, { type: "block-end", index: 0, block: { type: "text", text: final } }];
    assert.match(outputText(await collect(guardAnswerStream(source(input), { assemble }))), /回答闸拦截/);
  }
});
test("timeout flushes buffered text while upstream next remains unresolved", async () => {
  let resume;
  const pause = new Promise((r) => { resume = r; });
  async function* slow() { yield chunksOf("116 列")[0]; yield chunksOf("116 列")[1]; await pause; yield* chunksOf("116 列").slice(2); }
  const it = guardAnswerStream(slow(), { assemble, timeoutMs: 10 });
  const first = await Promise.race([it.next(), new Promise((_, reject) => setTimeout(() => reject(new Error("not flushed")), 300))]);
  assert.equal(first.value.type, "block-start");
  resume();
  const out = [first.value, ...await collect(it)];
  /*
CLAIM: 该用例改为断言超时后可见正文不含「回答闸」
COUNTER: 若其他路径仍拼入提示，断言会失败
CHECK: node --test 全部用例
VERDICT: 已验
*/
  assert.equal(assemble(out)[0].text, "116 列"); assert.doesNotMatch(outputText(out), /回答闸/);
  assert.doesNotMatch(outputText(out), /回答闸拦截/);
});
test("byte and chunk limits degrade with original chunks exactly once and notice before finish", async () => {
  for (const opts of [{ maxBytes: 1 }, { maxChunks: 1 }]) {
    const input = chunksOf("116 列");
    const out = await collect(guardAnswerStream(source(input), { assemble, ...opts }));
    /*
CLAIM: 字节/分块上限触发时同样不把「回答闸」写进可见正文
COUNTER: 若 finish 之前仍拼接提示，断言失败
CHECK: node --test 全部用例
VERDICT: 已验
*/
    assert.deepEqual(out.filter((c) => c.index === 0), input.filter((c) => c.index === 0));
    assert.doesNotMatch(outputText(out), /回答闸/); assert.equal(out.at(-1).type, "finish");
  }
});
test("slow or failed audit cannot delay or cancel output", async () => {
  for (const audit of [() => new Promise(() => {}), () => { throw Error("audit"); }]) {
    const input = chunksOf("ok");
    assert.deepEqual(await collect(guardAnswerStream(source(input), { assemble, audit })), input);
  }
});
test("upstream exception and explicit cancellation retain their error semantics", async () => {
  async function* broken() { yield chunksOf("secret")[0]; throw Error("upstream"); }
  await assert.rejects(collect(guardAnswerStream(broken(), { assemble })), /upstream/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run("secret", { signal: controller.signal }), /abort/i);
});
test("provider error and aborted finishes are preserved with tool chunks", async () => {
  for (const kind of ["error", "aborted"]) {
    const input = [...chunksOf("partial").slice(0, -1), { type: "finish", reason: { kind } }];
    assert.deepEqual(await collect(guardAnswerStream(source(input), { assemble })), input);
  }
});
/*
CLAIM: v32 起回答闸默认 off，只有显式 warn/block 才启用；未知值按 off 处理
COUNTER: 旧调用方若依赖"未设置即 block"，升级后行为会变；这是刻意变更，已在 docs/RELIABILITY-v32.md 写明
CHECK: 本用例 + 全量 node --test
VERDICT: 已验
*/
test("mode parser: explicit warn/block only, everything else is off", async () => {
  for (const [value, expected] of [["warn", "warn"], ["block", "block"], ["Block", "block"], ["off", "off"], ["0", "off"], ["oops", "off"], ["", "off"]]) assert.equal(answerGateMode(value), expected);
  assert.deepEqual(await run("999 列", { mode: "off" }), chunksOf("999 列"));
});
test("one exemption per session, consumed once; quoted, negated and injected text do not grant it", async () => {
  const state = createAnswerGateState();
  assert.equal(state("a", [user("本次免检")]).exempt, true);
  assert.equal(state("a", [user("本次免检")]).exempt, false);
  assert.equal(state("a", [user("不用闸")]).exempt, false);
  assert.equal(state("b", [user("不用闸")]).exempt, true);
  for (const text of ["不要免检", "文档里说‘免检’", "请解释免检"]) assert.equal(state(text, [user(text)]).exempt, false);
  assert.equal(state("c", [{ ...user("免检"), source: { kind: "answer-gate" } }]).exempt, false);
  assert.equal(state(undefined, [user("免检")]).exempt, false);
  assert.deepEqual(await run("999 列", { exempt: true }), chunksOf("999 列"));
});

test("masking multi-paragraph code retains correct prose snippets and previous denominator", () => {
  const text = "```js\nconst n=123;\n\nconst m=456;\n```\n\n116 列\n\n全部相同\n\n999 项";
  const result = checkAnswer(text, evidence(tool("a", "116")));
  assert.deepEqual(result.issues.map((i) => [i.rule, i.snippet]), [["number-source", "999 项"]]);
});

test("blocking multiple text blocks preserves contiguous starts and tool order", async () => {
  const input = [
    ...chunksOf("999 列").slice(0, -1),
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "another" },
    { type: "block-end", index: 1, block: { type: "text", text: "another" } },
    { type: "block-start", index: 2, blockType: "tool-call" },
    { type: "block-end", index: 2, block: { type: "tool-call", id: "read", name: "read", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
  const out = await collect(guardAnswerStream(source(input), { assemble }));
  assert.deepEqual(out.filter((c) => c.type === "block-start").map((c) => c.index), [0, 1, 2]);
  assert.equal(assemble(out)[1].text, "");
  assert.deepEqual(out.filter((c) => c.index === 2), input.filter((c) => c.index === 2));
});

/*
CLAIM: 两个用例改为断言"stream-limit/timeout 不再出现在可见正文"
COUNTER: 若闸门仍有其他路径把该提示拼进正文，doesNotMatch 会失败
CHECK: node --test 全部用例
VERDICT: 已验
*/
test("limit reached on finish still emits notice before the single finish", async () => {
  const input = chunksOf("ok");
  const out = await collect(guardAnswerStream(source(input), { assemble, maxChunks: input.length }));
  assert.equal(out.at(-1).type, "finish");
  assert.equal(out.filter((c) => c.type === "finish").length, 1);
  assert.doesNotMatch(outputText(out), /回答闸/);
});

test("timeout includes promised stream resolution without duplicate reads", async () => {
  let resolve;
  const stream = new Promise((r) => { resolve = r; });
  const it = guardAnswerStream(stream, { assemble, timeoutMs: 5 });
  const first = it.next();
  await new Promise((r) => setTimeout(r, 15));
  resolve(source(chunksOf("999 列")));
  const out = [(await first).value, ...await collect(it)];
  assert.equal(assemble(out)[0].text, "999 列");
  assert.doesNotMatch(outputText(out), /回答闸/);
});
