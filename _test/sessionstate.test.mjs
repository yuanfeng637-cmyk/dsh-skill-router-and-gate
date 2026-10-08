/**
 * sessionstate 单元测试（v14.3）：node --test _test/sessionstate.test.mjs
 * 起因：外部评审第二轮 —— 闸门状态必须**按会话**，尤其"技能目录"不能全局共享。
 * 本文件覆盖：交错目录、按会话隔离、LRU 上限、drop、markLoaded 语义、sidOf 兜底。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionState, NOAGENT } from "../lib/sessionstate.js";

const execOf = (sid, name, args = {}) => ({ name, arguments: args, agent: { id: sid } });

test("目录按会话：两个会话交错设置目录，各自读到自己那份（评审指出的主问题）", () => {
  const g = createSessionState({ maxSessions: 8 });
  g.setCatalog("A", ["pdf", "office-xlsx"]);
  g.setCatalog("B", ["tabular-read"]);
  assert.deepEqual([...g.catalogOf("A")].sort(), ["office-xlsx", "pdf"]);
  assert.deepEqual([...g.catalogOf("B")], ["tabular-read"]);
  // 交错再来一轮：A 被覆盖，不能污染 B
  g.setCatalog("A", ["pdf"]);
  assert.deepEqual([...g.catalogOf("A")], ["pdf"]);
  assert.deepEqual([...g.catalogOf("B")], ["tabular-read"]);
});

test("已加载按会话：A 加载不影响 B（v14.2 语义在容器层保持不变）", () => {
  const g = createSessionState();
  g.markLoaded("A", "pdf");
  assert.equal(g.loadedOf("A").has("pdf"), true);
  assert.equal(g.loadedOf("B").has("pdf"), false);
});

test("markLoaded：清掉**本会话**的拦截计数，不动别的会话", () => {
  const g = createSessionState();
  g.addDeny("A", "pdf"); g.addDeny("A", "pdf");  // A 被拦 2 次
  g.addDeny("B", "pdf"); g.addDeny("B", "pdf"); g.addDeny("B", "pdf"); // B 被拦 3 次
  assert.equal(g.deniesOf("A").get("pdf"), 2);
  g.markLoaded("A", "pdf");
  assert.equal(g.deniesOf("A").has("pdf"), false);
  assert.equal(g.deniesOf("B").get("pdf"), 3);
});

test("读接口不产生副作用：探测读既不建条目、也不触发淘汰（v14.3 首版的 bug）", () => {
  const g = createSessionState({ maxSessions: 2 });
  g.markLoaded("keep", "pdf");
  g.loadedOf("probe"); g.deniesOf("probe"); g.catalogOf("probe");   // 三个探测读
  assert.deepEqual(g.sizes(), { loadedSessions: 1, denySessions: 0, catalogSessions: 0 });
  assert.equal(g.loadedOf("keep").has("pdf"), true, "探测读不能把 keep 挤掉");
  // 读回来的空对象即使被误写，也不能污染别的会话
  g.deniesOf("probe").set("pdf", 99);
  assert.equal(g.deniesOf("probe").has("pdf"), false);
  assert.equal(g.deniesOf("keep").has("pdf"), false);
});

test("markLoaded：空名字不登记；返回布尔", () => {
  const g = createSessionState();
  assert.equal(g.markLoaded("A", "   "), false);
  assert.equal(g.markLoaded("A", null), false);
  assert.equal(g.loadedOf("A").size, 0);
  assert.equal(g.markLoaded("A", " pdf "), true);
  assert.deepEqual([...g.loadedOf("A")], ["pdf"]);
});

test("LRU 上限：超过 maxSessions 就淘汰最久未用的会话（三类状态都受限）", () => {
  const g = createSessionState({ maxSessions: 2 });
  g.markLoaded("s1", "pdf"); g.setCatalog("s1", ["pdf"]);
  g.markLoaded("s2", "pdf"); g.setCatalog("s2", ["pdf"]);
  g.loadedOf("s1"); // 触达 s1 ⇒ s2 变成最久未用
  g.markLoaded("s3", "pdf"); g.setCatalog("s3", ["pdf"]);
  const s = g.sizes();
  assert.equal(s.loadedSessions, 2);
  assert.equal(s.catalogSessions, 2);
  assert.equal(g.loadedOf("s2").size, 0, "s2 应被淘汰（读出来是新建的空集合）");
  assert.equal(g.loadedOf("s1").has("pdf"), true);
  assert.equal(g.loadedOf("s3").has("pdf"), true);
});

test("drop：会话结束时三类状态一起清", () => {
  const g = createSessionState();
  g.markLoaded("A", "pdf"); g.setCatalog("A", ["pdf"]); g.addDeny("A", "docx");
  g.drop("A");
  assert.deepEqual(g.sizes(), { loadedSessions: 0, denySessions: 0, catalogSessions: 0 });
});

test("sidOf：取 exec.agent.id；缺失时归到统一桶", () => {
  const g = createSessionState();
  assert.equal(g.sidOf(execOf("abc", "skill")), "abc");
  assert.equal(g.sidOf({ name: "skill", arguments: {} }), NOAGENT);
  assert.equal(g.sidOf({ agent: {} }), NOAGENT);
  assert.equal(g.sidOf(null), NOAGENT);
});

test("denySummary：全会话合计（status 展示用）", () => {
  const g = createSessionState();
  g.addDeny("A", "pdf"); g.addDeny("A", "pdf");
  g.addDeny("B", "pdf"); g.addDeny("B", "office-xlsx"); g.addDeny("B", "office-xlsx");
  g.addDeny("B", "office-xlsx"); g.addDeny("B", "office-xlsx");
  const agg = Object.fromEntries(g.denySummary());
  assert.deepEqual(agg, { pdf: 3, "office-xlsx": 4 });
});
