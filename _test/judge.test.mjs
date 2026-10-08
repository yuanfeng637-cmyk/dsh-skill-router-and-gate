// 判定层离线单测：只测 lib/judge.js 的纯逻辑 + runJudge 的流拼装/超时包装。
// 不触碰 DSH 运行时，不需要 llm 服务。
import { strict as assert } from "node:assert";
import {
  JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  buildJudgeSystem,
  catalogEntries,
  collectStream,
  parseJudgeOutput,
  renderCatalog,
  runJudge,
  tokensOf,
  withTimeout,
} from "../lib/judge.js";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log("  ok   " + name);
  } catch (e) {
    console.log("  FAIL " + name + " -> " + e.message);
    process.exitCode = 1;
  }
};

// 1) 目录渲染：按 name 固定排序、与输入顺序无关、截断生效
t("catalogEntries 固定排序 + 截断", () => {
  const a = catalogEntries([{ name: "zeta", description: "x".repeat(500) }, { name: "alpha", description: "短" }], { descMax: 10 });
  const b = catalogEntries([{ name: "alpha", description: "短" }, { name: "zeta", description: "x".repeat(500) }], { descMax: 10 });
  assert.deepEqual(a.map((r) => r.name), ["alpha", "zeta"]);
  assert.deepEqual(a, b);
  assert.equal(a[1].description.length, 11); // 10 + 省略号
  assert.ok(renderCatalog(a).includes("`alpha`"));
});

// 2) 系统提示词与用户提示词：含机制规则、不含置信度样例值
t("prompt 构造", () => {
  const sys = buildJudgeSystem(2);
  assert.ok(sys.includes("not evidence by itself"));
  assert.ok(sys.includes("unsure"));
  assert.ok(sys.includes("At most 2 entries"));
  const p = buildJudgePrompt({ query: "你确定吗", catalogText: "- `a`: b" });
  assert.ok(p.includes("<<<") && p.includes("你确定吗") && p.includes("- `a`: b"));
});

// 3) 严格解析
const allowed = new Map([["claim-check", "claim-check"], ["paper-cn", "paper-cn"]]);
t("parse：正常 pick", () => {
  const r = parseJudgeOutput('{"skills":[{"name":"claim-check","confidence":0.8,"why":"要下结论"}]}', allowed, { maxPicks: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.decision, "pick");
  assert.deepEqual(r.picks.map((p) => p.name), ["claim-check"]);
  assert.equal(r.picks[0].confidence, 0.8);
});
t("parse：空数组 = none", () => {
  assert.equal(parseJudgeOutput('{"skills":[]}', allowed).decision, "none");
});
t("parse：unsure", () => {
  const r = parseJudgeOutput('{"unsure":true}', allowed);
  assert.equal(r.ok, true);
  assert.equal(r.decision, "unsure");
});
t("parse：代码围栏 + 前后废话", () => {
  const r = parseJudgeOutput('好的：\n```json\n{"skills":[{"name":"paper-cn"}]}\n```\n完毕', allowed);
  assert.equal(r.decision, "pick");
  assert.equal(r.picks[0].confidence, null);
});
t("parse：幻觉名字被丢弃（白名单）", () => {
  const r = parseJudgeOutput('{"skills":[{"name":"not-a-skill"},{"name":"CLAIM-CHECK"}]}', allowed);
  assert.deepEqual(r.picks.map((p) => p.name), ["claim-check"]);
  assert.deepEqual(r.unknown, ["not-a-skill"]);
});
t("parse：越界置信度记 null，不编数", () => {
  assert.equal(parseJudgeOutput('{"skills":[{"name":"paper-cn","confidence":1.5}]}', allowed).picks[0].confidence, null);
});
t("parse：重复名字去重 + 截断到 maxPicks", () => {
  const r = parseJudgeOutput('{"skills":[{"name":"paper-cn"},{"name":"paper-cn"},{"name":"claim-check"}]}', allowed, { maxPicks: 1 });
  assert.equal(r.picks.length, 1);
});
t("parse：无效输出必须 ok=false（不能被当成 none）", () => {
  for (const bad of ["", "no json here", "{oops", '{"skills":"nope"}']) {
    assert.equal(parseJudgeOutput(bad, allowed).ok, false, "should fail: " + bad);
  }
});
t("parse：全是幻觉名字 ⇒ ok=false（v14.2，不能当成合法 none）", () => {
  const r = parseJudgeOutput('{"skills":[{"name":"not-a-skill"},{"name":"also-fake"}]}', allowed);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "all-unknown");
  assert.deepEqual(r.unknown, ["not-a-skill", "also-fake"]);
});
t("parse：空数组仍是合法 none（v14.2 的修正不能把它也判成无效）", () => {
  const r = parseJudgeOutput('{"skills":[]}', allowed);
  assert.equal(r.ok, true);
  assert.equal(r.decision, "none");
});

// 4) 流拼装
async function collectOf(chunks) {
  return collectStream((async function* () { for (const c of chunks) yield c; })());
}
const streamTests = (async () => {
  const deltas = await collectOf([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: '{"skills":' },
    { type: "text-delta", index: 0, text: "[]}" },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 5 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  assert.equal(deltas.text, '{"skills":[]}');
  assert.equal(deltas.usage.inputTokens, 100);
  assert.equal(deltas.finish.kind, "stop");
  pass += 1;
  console.log("  ok   collectStream：text-delta 拼接 + usage/finish");

  const blocks = await collectOf([
    { type: "block-end", index: 1, block: { type: "text", text: "B" } },
    { type: "block-end", index: 0, block: { type: "text", text: "A" } },
  ]);
  assert.equal(blocks.text, "AB"); // 只有 block-end 时按 index 排序
  pass += 1;
  console.log("  ok   collectStream：仅 block-end 时按 index 排序");

  // 首次活运行时的真实故障形态（2026-10-07 19:31）：token 全花在推理上、
  // 正文零字符、finish=max-tokens ⇒ 必须判为"无效"而不是"none"。
  const reasoning = await collectOf([
    { type: "reasoning-delta", index: 0, text: "想" },
    { type: "reasoning-delta", index: 0, text: "很久" },
    { type: "finish", reason: { kind: "max-tokens" } },
  ]);
  assert.equal(reasoning.text, "");
  assert.equal(reasoning.reasoningChars, 3);
  assert.equal(reasoning.finish.kind, "max-tokens");
  assert.equal(parseJudgeOutput(reasoning.text, allowed).ok, false, "没有正文时必须是无效，不能当 none");
  pass += 1;
  console.log("  ok   collectStream：推理字符单独计数；正文为空 ⇒ 判定无效（不是 none）");

  assert.equal(tokensOf(undefined), null);
  assert.equal(tokensOf({}), null);
  // 首次活运行的测量口径问题：同一提示词两次报 in=1556 / in=148 ⇒ 把缓存命中
  // 也一起记，免得把成本读错（缺的字段一律 null，不估算）。
  const tk = tokensOf({ inputTokens: 3, cacheReadTokens: 1500 });
  assert.equal(tk.in, 3);
  assert.equal(tk.out, null);
  assert.equal(tk.cacheRead, 1500);
  assert.equal(tk.total, null);
  assert.equal(tk.reasoning, null);
  pass += 1;
  console.log("  ok   tokensOf：缺 usage 记 null；缓存命中/总量一起记");
})();

// 5) 超时包装 + runJudge（假 llm）
const judgeTests = (async () => {
  const g1 = withTimeout(undefined, 50);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(g1.signal.aborted, true);
  assert.equal(g1.timedOut(), true);
  g1.dispose();
  pass += 1;
  console.log("  ok   withTimeout：到点 abort 且 timedOut=true");

  const outer = new AbortController();
  const g2 = withTimeout(outer.signal, 5000);
  outer.abort(new Error("step aborted"));
  assert.equal(g2.signal.aborted, true);
  assert.equal(g2.timedOut(), false);
  g2.dispose();
  pass += 1;
  console.log("  ok   withTimeout：透传外层 signal（且不算超时）");

  let seen = null;
  const fakeLlm = {
    stream(options) {
      seen = options;
      return (async function* () {
        yield { type: "text-delta", index: 0, text: '{"skills":[{"name":"paper-cn"}]}' };
        yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const r = await runJudge({
    llm: fakeLlm,
    route: { provider: "p", model: "m" },
    system: "SYS",
    prompt: "PROMPT",
    maxTokens: 123,
    timeoutMs: 3000,
  });
  assert.equal(r.text, '{"skills":[{"name":"paper-cn"}]}');
  assert.equal(r.timedOut, false);
  assert.equal(seen.provider, "p");
  assert.equal(seen.model, "m");
  assert.equal(seen.system, "SYS");
  assert.equal(seen.maxTokens, 123);
  assert.equal(seen.temperature, 0);
  assert.equal(seen.purpose, undefined, "不许伪造 purpose 标记");
  assert.equal(seen.messages[0].content[0].text, "PROMPT");
  assert.ok(seen.signal instanceof AbortSignal, "必须把可取消 signal 传给 llm.stream");
  pass += 1;
  console.log("  ok   runJudge：路由/系统/温度/maxTokens/messages/signal 全部透传");

  // 超时路径：流遵守 signal（真实 adapter 的行为）——abort 后必须自己结束
  const hanging = {
    stream: (options) =>
      (async function* () {
        await new Promise((_, reject) => {
          if (options.signal.aborted) return reject(new Error("aborted"));
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })(),
  };
  const started = Date.now();
  const r2 = await runJudge({ llm: hanging, route: { provider: "p", model: "m" }, system: "s", prompt: "p", timeoutMs: 120 });
  assert.equal(r2.timedOut, true);
  assert.equal(r2.text, "");
  assert.ok(Date.now() - started < 3000, "超时必须及时返回");
  pass += 1;
  console.log("  ok   runJudge：超时转成 timedOut=true 的返回，而不是抛异常");

  // v14.2（外部评审）：**忽略 abort 的流**也必须在墙钟上限内返回（旧实现会一直等下去）
  const deaf = {
    stream: () =>
      (async function* () {
        await new Promise(() => {}); // 永不结束、也不理 signal
      })(),
  };
  const t0 = Date.now();
  const r3 = await runJudge({ llm: deaf, route: { provider: "p", model: "m" }, system: "s", prompt: "p", timeoutMs: 120 });
  assert.equal(r3.timedOut, true);
  assert.ok(Date.now() - t0 < 2000, "忽略 abort 的流也必须按时返回");
  pass += 1;
  console.log("  ok   runJudge：忽略 abort 的流也按时返回 timedOut=true（v14.2 的 Promise.race）");
})();

await Promise.all([streamTests, judgeTests]);
console.log("\npromptVersion = " + JUDGE_PROMPT_VERSION);
console.log(process.exitCode ? "有失败项" : `全部通过（${pass} 项）`);
