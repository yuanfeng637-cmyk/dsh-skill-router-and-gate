/**
 * dsh-skill-router-and-gate / lib/judge.js —— 判定层（v13）
 *
 * 设计依据（外部评审 + 本机实测，2026-10-07）：
 *   - 在线判定用**一次 llm.stream**（不建会话、不落盘、可 signal 取消）；
 *     不在每轮常规路由里启动真子 agent —— 子会话自己也会跑 agent/pre-step，
 *     而现有契约里没有"跳过 router"的可靠标记，会形成回环。
 *   - 传给判定员的目录必须是**与 query 无关的固定目录**：不能把词法检索的候选
 *     顺序或"高分项"带进去，否则就是拿旧 router 的结论锚定判定员。
 *   - 输出只允许 pick / none / unsure 三种；名字必须落在白名单里。
 *   - 本模块**不 import 任何 Cordis/DSH 东西**，因此可以在宿主里被命令直接调用
 *     （`/skill-gate eval`），做"不经过 Agent、因而不会被 router 注入污染"的标定。
 */

export const JUDGE_PROMPT_VERSION = "v13.1";

const DEFAULT_DESC_MAX = 200;
const DEFAULT_WHEN_MAX = 120;
const WHY_MAX = 120;

function squeeze(v, n) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 目录行：按 **name 字典序** 固定排列（与 query、与词法分数都无关）。
 * `description` 与 `whenToUse` 都截断，保证每轮输入尺寸可预测。
 */
export function catalogEntries(skills, options = {}) {
  const descMax = options.descMax ?? DEFAULT_DESC_MAX;
  const whenMax = options.whenMax ?? DEFAULT_WHEN_MAX;
  return (skills ?? [])
    .filter((s) => s && typeof s.name === "string" && s.name.length > 0)
    .map((s) => ({
      name: s.name,
      description: squeeze(s.description, descMax),
      whenToUse: squeeze(s.whenToUse, whenMax),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function renderCatalog(rows) {
  return (rows ?? [])
    .map((r) => {
      const when = r.whenToUse ? ` Use when: ${r.whenToUse}` : "";
      return `- \`${r.name}\`: ${r.description || "(no description)"}${when}`;
    })
    .join("\n");
}

/**
 * 系统提示词。规则必须是**可迁移的机制规则**，不是针对某几条用例的特例
 * （外部评审原文：不要把 16 条用例逐条变成特例）。
 */
export function buildJudgeSystem(maxPicks = 2) {
  return [
    "You are the skill router inside a DeepSeek Harness session. Decide which of the available skills, if any, the assistant must load before its next action, for the latest user message.",
    "",
    "Rules (these are rules about the mechanism, not about individual skills):",
    '- A skill applies only when its own stated trigger matches what this message asks for. Shared words, topic similarity, or a general verb ("select", "check", "clean", "compare", "review") is not evidence by itself.',
    "- Session-discipline or project-memory skills require an applicable project context or an explicit session-start condition. The mere arrival of a new user message is not a session-start signal.",
    '- "Might be related" is not "this task needs it". When there is no concrete task evidence, return an empty list.',
    "- An empty list is the normal, expected answer for chat, opinions, meta questions about tooling, and design discussion.",
    "- Never invent names. Use exact names from the catalog.",
    '- If the message is genuinely ambiguous and you cannot tell whether a skill applies, set "unsure": true instead of guessing.',
    "",
    "Reply with ONE JSON object and nothing else:",
    '{"skills":[{"name":"<exact name from the catalog>","confidence":0.0,"why":"<8 words, in the user\'s language>"}]}',
    `Add "unsure": true only in the ambiguous case. At most ${maxPicks} entries; an empty array is valid.`,
  ].join("\n");
}

export function buildJudgePrompt({ query, catalogText }) {
  return [
    "Latest user message:",
    "<<<",
    String(query ?? ""),
    ">>>",
    "",
    "Available skills (this session's catalog; identical for every request in this session):",
    catalogText || "(none)",
  ].join("\n");
}

/**
 * 严格解析。allowed 是 Map<小写名, 规范名>。
 * 返回 { ok, decision, picks, unknown, reason }。
 *   ok=false ⇒ 输出无效，调用方走严格词法兜底（不得当成 none）。
 */
export function parseJudgeOutput(text, allowed, options = {}) {
  const maxPicks = options.maxPicks ?? 2;
  const raw = String(text ?? "").replace(/```[a-zA-Z]*/g, "").trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return { ok: false, decision: null, picks: [], reason: "no-json-object" };
  let obj;
  try {
    obj = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return { ok: false, decision: null, picks: [], reason: "json-parse-failed" };
  }
  if (obj && typeof obj === "object" && obj.unsure === true) {
    return { ok: true, decision: "unsure", picks: [], unknown: [] };
  }
  const arr = Array.isArray(obj?.skills) ? obj.skills : Array.isArray(obj) ? obj : null;
  if (!arr) return { ok: false, decision: null, picks: [], reason: "no-skills-array" };
  const picks = [];
  const unknown = [];
  for (const entry of arr) {
    const name = typeof entry === "string" ? entry : entry && typeof entry.name === "string" ? entry.name : null;
    if (!name) continue;
    const canonical = allowed && allowed.get ? allowed.get(String(name).trim().toLowerCase()) : undefined;
    if (!canonical) {
      unknown.push(String(name).trim().slice(0, 60));
      continue;
    }
    if (picks.some((p) => p.name === canonical)) continue;
    const conf =
      entry && typeof entry.confidence === "number" && entry.confidence > 0 && entry.confidence <= 1
        ? entry.confidence
        : null;
    const why = entry && typeof entry.why === "string" ? squeeze(entry.why, WHY_MAX) : "";
    picks.push({ name: canonical, confidence: conf, why });
  }
  // v14.2（外部评审）：**名字全在白名单外**不能算合法的 none —— 那是判定员在幻觉，
  // 必须 ok=false 让调用方走词法兜底，否则会静默漏推荐。
  // 注意：空数组 `[]` 仍是合法的 none（判定员明确表示"没有适用的技能"），别把它也判成无效。
  if (picks.length === 0 && unknown.length > 0) {
    return { ok: false, decision: null, picks: [], unknown, reason: "all-unknown" };
  }
  return { ok: true, decision: picks.length ? "pick" : "none", picks: picks.slice(0, maxPicks), unknown };
}

/** 把 chunk 流拼成文本；usage 只取 adapter 报的，缺了就记 null（不许估）。 */
export async function collectStream(stream) {
  let text = "";
  let usage = null;
  let finish = null;
  let reasoningChars = 0;
  const blocks = new Map();
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") reasoningChars += chunk.text.length;
    else if (chunk.type === "block-end" && chunk.block && chunk.block.type === "text" && typeof chunk.block.text === "string") {
      blocks.set(chunk.index, chunk.block.text);
    } else if (chunk.type === "usage") usage = chunk.usage ?? null;
    else if (chunk.type === "finish") finish = chunk.reason ?? null;
  }
  if (!text.trim() && blocks.size > 0) {
    text = [...blocks.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v).join("");
  }
  return { text, usage, finish, reasoningChars };
}

/** 墙钟上限；透传调用方 signal，且**不自动重试**。 */
export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let fire = null;
  // v14.2（外部评审）：除了 abort，还给调用方一个**到点即兑现**的 promise ——
  // 不能再假定 adapter 一定会因 abort 结束流（旧的 `await collectStream` 会被永不结束的流挂住）。
  const timeoutHit = new Promise((resolve) => { fire = resolve; });
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else if (typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("skill-gate judge timeout"));
    fire();
  }, timeoutMs);
  // ⚠ 故意**不 unref**：unref 过的定时器在"事件循环没有别的活"时不会触发，
  // 会让超时静默失效（离线单测就是这么抓到它的）。定时器在 dispose() 里清掉，
  // 最长存活 timeoutMs，不构成泄漏。
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    timeoutHit,
    dispose() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
    },
  };
}

export function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
  if (input === null && output === null) return null;
  const num = (v) => (typeof v === "number" ? v : null);
  // ⚠ 首次活运行的测量口径问题：同一个 17 条目录的提示词，两次调用报的
  // `inputTokens` 是 1556 与 148。怀疑 adapter 的 inputTokens 不含**缓存命中**部分，
  // 所以把 cache/total 一起记下来，免得把成本读错。
  return {
    in: input,
    out: output,
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    total: num(usage.totalTokens),
    reasoning: num(usage.reasoningTokens),
  };
}

/**
 * 跑一次判定。llm 是 `ctx.get("llm")` 拿到的服务；route = {provider, model}。
 * 不传 `purpose`：契约里它只接受 'compaction' | 'session-title'，不许拿来冒充路由标记。
 */
export async function runJudge({ llm, route, system, prompt, signal, maxTokens = 300, timeoutMs = 8000 }) {
  const started = Date.now();
  const guard = withTimeout(signal, timeoutMs);
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      temperature: 0,
      maxTokens,
      signal: guard.signal,
    });
    const collecting = collectStream(stream);
    // v14.2：与超时信号**赛跑** —— 这才是真正的墙钟上限。
    const TIMEOUT = Symbol("judge-timeout");
    const collected = await Promise.race([collecting, guard.timeoutHit.then(() => TIMEOUT)]);
    if (collected === TIMEOUT) {
      collecting.catch(() => {}); // 吞掉迟到者的 rejection，避免 unhandledRejection
      return { text: "", usage: null, finish: null, reasoningChars: 0, ms: Date.now() - started, timedOut: true };
    }
    return { ...collected, ms: Date.now() - started, timedOut: guard.timedOut() };
  } catch (error) {
    // 超时是我们自己 abort 出来的：必须转成 timedOut=true 的**正常返回**，
    // 否则调用方只能看到一个普通异常，trace 里分不清"超时"和"报错"。
    if (guard.timedOut()) {
      return { text: "", usage: null, finish: null, reasoningChars: 0, ms: Date.now() - started, timedOut: true };
    }
    throw error;
  } finally {
    guard.dispose();
  }
}
