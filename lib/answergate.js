/** Lexical provenance checks: numeric presence never proves semantic support. */
import { createHash } from "node:crypto";
const digitText = (s) => String(s).replace(/[０-９٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) - (c >= "０" ? 0xff10 : c >= "۰" ? 0x6f0 : 0x660)));
const normalize = (s) => s.replaceAll(",", "").replaceAll("−", "-").replace(/^\+/, "").toLowerCase();
export function numbersOf(text) {
  return [...digitText(text).matchAll(/[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+−-]?\d+)?/g)]
    .map((m) => ({ value: normalize(m[0]), raw: String(text).slice(m.index, m.index + m[0].length), offset: m.index }));
}
const textOf = (c) => typeof c === "string" ? c : (Array.isArray(c) ? c : []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
const userTurn = (m) => m?.role === "user" && (!m.source?.kind || ["user", "goal"].includes(m.source.kind));
const limit = (n, fallback, max) => Number.isInteger(Number(n)) && Number(n) > 0 ? Math.min(Number(n), max) : fallback;
/*
CLAIM: 回答闸改为显式开启：只有 DSH_ANSWER_GATE=warn|block 才启用，未设置即 off
COUNTER: 默认 off 之后不再自动拦无证据数字；需要的人必须显式设环境变量
CHECK: answergate.test.mjs 顶部显式设 block 后全量通过；未设时 mode() === "off"
VERDICT: 已验
*/
export function answerGateMode(value = process.env.DSH_ANSWER_GATE) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "warn" || v === "block" ? v : "off";
}
/** All supplied history, bounded by tool results rather than user turns. */
export function collectAnswerEvidence(messages = [], { maxResults = 1000, maxChars = 262144, maxResultChars = 65536, maxNumbers = 8192, previous = new Map() } = {}) {
  maxResults = limit(maxResults, 1000, 10000);
  maxChars = limit(maxChars, 262144, 4194304);
  maxResultChars = limit(maxResultChars, 65536, maxChars);
  maxNumbers = limit(maxNumbers, 8192, 65536);
  const calls = new Map(), outputs = [], failures = [], resultRows = [];
  const tools = messages.filter((m) => m?.role === "tool");
  const selected = new Set(tools.slice(-maxResults));
  let remaining = maxChars, remainingNumbers = maxNumbers, incomplete = tools.length > maxResults;
  const totalTurns = messages.filter(userTurn).length;
  let turn = 0;
  for (const m of messages) {
    if (userTurn(m)) turn++;
    if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool-call") calls.set(String(b.id), b);
    if (m?.role !== "tool" || !selected.has(m)) continue;
    const text = textOf(m.content), id = String(m.toolCallId ?? m.source?.callId ?? "");
    resultRows.push({ text, id });
    const call = calls.get(id);
    if (m.isError !== true || turn !== totalTurns || !call || !text.trim()) continue;
    let args = call.arguments;
    try { if (typeof args === "string") args = JSON.parse(args); } catch { /* literal */ }
    const detail = args && typeof args === "object" ? args.command ?? args.cmd ?? args.file_path ?? args.filePath ?? args.path : args;
    if (!detail) continue;
    const name = String(call.name), command = String(detail).trim().replace(/\s+/g, " ");
    failures.push({ id, name, command, method: `${name} ${command}`, signature: `${name} ${command}`, failure: text.trim().split(/\r?\n/)[0].slice(0, 160) });
  }
  // Spend parsing budgets on the newest results first, while keeping output
  // order chronological for the session LRU and existing provenance consumers.
  for (const { text, id } of resultRows.reverse()) {
    const key = id || createHash("sha256").update(text).digest("hex");
    // Retain only numeric evidence, never entire tool payloads. Any bounded
    // evidence loss makes absence checks advisory rather than a hard denial.
    let slice = text.slice(0, Math.min(maxResultChars, remaining));
    remaining -= slice.length;
    if (slice.length < text.length) slice = slice.replace(/\S+$/u, "");
    const digest = createHash("sha256").update(slice).digest("hex");
    const cached = previous.get(key);
    let values = cached?.digest === digest && !cached.incomplete ? [...cached.numbers] : numbersOf(slice).map((n) => n.value);
    values = [...new Set(values)];
    const truncated = slice.length < text.length || values.length > remainingNumbers;
    values = values.slice(0, remainingNumbers); remainingNumbers -= values.length;
    incomplete ||= truncated;
    outputs.push({ id, key, digest, numbers: new Set(values), incomplete: truncated });
  }
  const kept = outputs.reverse().slice(-maxResults);
  return { outputs: kept, failures: failures.filter((f) => kept.some((o) => o.id === f.id)), maxResults, incomplete };
}
/** Bounded session LRU retains observed evidence after request history truncation. */
export function createAnswerGateState({ maxSessions = 64, maxResults = 1000, maxNumbers = 8192, ...limits } = {}) {
  const sessions = new Map();
  maxSessions = limit(maxSessions, 64, 4096); maxResults = limit(maxResults, 1000, 10000);
  maxNumbers = limit(maxNumbers, 8192, 65536);
  limits.maxChars = limit(limits.maxChars, 262144, 4194304);
  const observe = (sessionId, messages = []) => {
    const prior = sessions.get(sessionId);
    const current = collectAnswerEvidence(messages, { ...limits, maxResults, maxNumbers, previous: new Map((prior?.outputs ?? []).map((o) => [o.key, o])) });
    if (!sessionId) return { evidence: current, exempt: false };
    const state = sessions.get(sessionId) ?? { outputs: [], used: false };
    sessions.delete(sessionId); sessions.set(sessionId, state);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    const merged = new Map(state.outputs.map((o) => [o.key, o]));
    for (const o of current.outputs) { merged.delete(o.key); merged.set(o.key, o); }
    state.outputs = [...merged.values()].slice(-maxResults);
    state.incomplete ||= current.incomplete || merged.size > maxResults;
    let count = 0, chars = 0;
    for (let i = state.outputs.length - 1; i >= 0; i--) {
      count += state.outputs[i].numbers.size;
      chars += [...state.outputs[i].numbers].reduce((sum, n) => sum + n.length, 0);
      if (count > maxNumbers || chars > (limits.maxChars ?? 262144)) { state.outputs = state.outputs.slice(i + 1); state.incomplete = true; break; }
    }
    const request = textOf(messages.findLast(userTurn)?.content);
    const exempt = !state.used && /(?:^|[\n。；;！!])\s*(?:(?:本次|这次|本轮|请)\s*)*(?:免检|不用闸)(?:[\s，,。！!；;]|$)/.test(request);
    if (exempt) state.used = true;
    return { evidence: { ...current, outputs: state.outputs, incomplete: !!state.incomplete }, exempt };
  };
  observe.drop = (sessionId) => sessions.delete(sessionId);
  observe.size = () => sessions.size;
  observe.remind = (sessionId, mode) => {
    if (!sessionId) return true;
    const state = sessions.get(sessionId) ?? { outputs: [], used: false };
    const needed = state.reminder !== mode;
    state.reminder = mode;
    sessions.delete(sessionId); sessions.set(sessionId, state);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return needed;
  };
  return observe;
}
function prose(text) {
  return text.replace(/```[^]*?```|~~~[^]*?~~~|`[^`\n]*`|\[失败证据:[^\]\n]+\]|(?<![\w\d])(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s，。；）)]+|\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b|\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|\b[vV]\d+(?:\.\d+)*(?:[-+][\w.-]+)?|\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?|(?:版本(?:号)?|VERSION)\s*[:=：]?\s*\d+(?:\.\d+)*/g,
    (s) => s.replace(/[^\r\n]/g, " "));
}
const UNIVERSAL = /全部|所有|一致|\b(?:every|all)\b/i;
const HARD_UNIVERSAL = /(?:全部|所有)[^。！？\n]{0,30}(?:相同|一致|通过|成功|失败|完成)|\b(?:all|every)\b[^.!?\n]{0,40}\b(?:passed|identical|succeeded|failed|completed)\b/i;
const UNAVAILABLE = /不支持|不可用|无此接口|\b(?:unavailable|unsupported|not supported|no such (?:tool|interface))\b/i;
const HARD_UNAVAILABLE = /(?:无法|不能)(?:使用|调用|读取|执行)任何|(?:所有|全部)[^。！？\n]{0,20}(?:不可用|不支持)|\bno (?:tools?|interfaces?) (?:are |is )?available\b/i;
function denominators(p) {
  return [...digitText(p).matchAll(/分母\s*[=＝:：]\s*(\d+)(?![\d.,eE])|(?:^|[^\d.])(\d+)\s*(?:列|条|链|项)|\b\d+\s*\/\s*(\d+)\s*(?:相同|一致|通过)|共\s*(\d+)\s*项/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}
export function checkAnswer(text, evidence) {
  const issues = [], matches = [], outputs = evidence?.outputs ?? [];
  const numericSources = new Map();
  for (const output of outputs) for (const value of output.numbers) if (!numericSources.has(value)) numericSources.set(value, output.id);
  const rawParagraphs = String(text).split(/\r?\n\s*\r?\n/);
  const masked = prose(String(text));
  let offset = 0;
  const paragraphs = rawParagraphs.map((raw) => {
    const start = String(text).indexOf(raw, offset);
    offset = start + raw.length;
    return masked.slice(start, offset);
  });
  for (const [paragraph, p] of paragraphs.entries()) {
    const raw = rawParagraphs[paragraph] ?? p;
    const add = (rule, severity, trigger, value) => issues.push({ rule, severity, paragraph, trigger, value, snippet: raw.trim().slice(0, 240) });
    for (const n of numbersOf(p)) {
      if (numericSources.has(n.value)) matches.push({ paragraph, value: n.raw, toolCallId: numericSources.get(n.value) });
      else if (!/\[未验\]\s*$/.test(p.slice(0, n.offset))) {
        const hard = /^\s*(?:列|条|链|项|个|次|%|％|字节|bytes?\b|tests?\b)/i.test(p.slice(n.offset + n.raw.length))
          || /(?:计数|数量|总数|通过|失败|耗时)\s*[:=：]?\s*$/.test(p.slice(0, n.offset));
        add("number-source", hard ? "block" : "warn", n.raw, n.raw);
      }
    }
    const universal = p.match(UNIVERSAL);
    if (universal && !(UNAVAILABLE.test(p) && !HARD_UNIVERSAL.test(p))) {
      const ds = denominators(p + "\n" + (paragraphs[paragraph - 1] ?? ""));
      if (!ds.some((n) => numericSources.has(normalize(n)))) add("denominator", HARD_UNIVERSAL.test(p) ? "block" : "warn", universal[0]);
    }
    const unavailable = p.match(UNAVAILABLE) ?? p.match(HARD_UNAVAILABLE);
    if (unavailable) {
      const cited = (evidence?.failures ?? []).filter((f) => raw.includes(f.name) && raw.includes(f.command) && raw.includes(f.failure));
      const hard = HARD_UNAVAILABLE.test(p);
      if (new Set(cited.map((f) => f.signature)).size < (hard ? 2 : 1)) add("unavailable-evidence", hard ? "block" : "warn", unavailable[0]);
    }
  }
  if (evidence?.incomplete) for (const issue of issues) issue.severity = "warn";
  return { ok: issues.length === 0, issues, matches, evidenceIncomplete: !!evidence?.incomplete };
}
export function answerGateNotice(issues, blocked = false) {
  const labels = { "number-source": ["数字无出处", "标[未验]或补工具输出"], denominator: ["分母缺证据", "在本段或紧邻上一段补可溯源分母"], "unavailable-evidence": ["不可用缺失败证据", "补工具名、命令或路径、失败输出首行"], "stream-limit": ["缓存降级", "本次按warn放行，检查未完成"] };
  /*
CLAIM: 过滤后 stream-limit（闸门自身降级）不再出现在用户可见正文，只留 trace
COUNTER: 若同一条回复里还有别的 issue，那些仍会显示；过滤只针对自身降级
CHECK: 单测 answergate.test.mjs 的 notice 用例 + 实机回复末尾
VERDICT: 已验
*/
  const shown = issues.filter((i) => i.rule !== "stream-limit");
  if (!shown.length && !blocked) return "";
  const lines = [...new Set(shown.map((i) => {
    const [type, suggestion] = labels[i.rule] ?? [i.rule, "补充证据"];
    const clean = (s) => String(s ?? "").replace(/[\r\n]/g, " ");
    return `[回答闸] 类型=${type} | 命中=${clean(i.value ?? i.trigger)} | 片段=${clean(i.snippet)} | 建议=${suggestion}`;
  }))];
  return (blocked ? "[回答闸拦截] 正文含缺证据的事实断言；工具调用继续。\n" : "") + lines.join("\n");
}
function* textChunks(text, index) {
  yield { type: "block-start", index, blockType: "text" };
  yield { type: "text-delta", index, text };
  yield { type: "block-end", index, block: { type: "text", text } };
}
function checkStreamChunks(chunks, evidence, assemble) {
  const final = checkAnswer(assemble(chunks).filter((b) => b.type === "text").map((b) => b.text).join("\n\n"), evidence);
  const deltas = new Map();
  for (const c of chunks) if (c.type === "text-delta") deltas.set(c.index, (deltas.get(c.index) ?? "") + c.text);
  const live = checkAnswer([...deltas.values()].join("\n\n"), evidence);
  const issues = [...new Map([...final.issues, ...live.issues].map((i) => [JSON.stringify(i), i])).values()];
  return { ...final, ok: !issues.length, issues };
}
export async function* guardAnswerStream(stream, { messages, evidence, signal, assemble, audit = () => {}, mode = answerGateMode(), exempt = false,
  maxResults = 1000, maxBytes = 1024 * 1024, maxChunks = 10000, timeoutMs = 2000 } = {}) {
  if (mode === "off" || exempt) { yield* await stream; return; }
  signal?.throwIfAborted?.();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("answer gate aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  void cancelled.catch(() => {});
  const wait = (promise) => Promise.race([promise, cancelled]);
  const chunks = [];
  let bytes = 0, nextIndex = 0, iterator;
  const deadline = Date.now() + limit(timeoutMs, 2000, 60000);
  let pending = Promise.resolve(stream).then((s) => { iterator = s[Symbol.asyncIterator](); return iterator.next(); });
  const timeout = Symbol("timeout");
  const log = (r) => { void Promise.resolve().then(() => audit(r)).catch(() => {}); };
  try {
    if (mode === "warn") {
      // Advisory mode never needs to delay live chunks. Keep only a bounded
      // audit copy; tool-bearing streams remain byte-for-byte unchanged.
      let hasTools = false, limited = false;
      while (true) {
        const item = await wait(pending);
        if (item.done) break;
        const c = item.value;
        hasTools ||= c.blockType === "tool-call" || c.block?.type === "tool-call";
        if (Number.isInteger(c.index)) nextIndex = Math.max(nextIndex, c.index + 1);
        if (!limited && c.type !== "finish") {
          const size = Buffer.byteLength(JSON.stringify(c));
          if (bytes + size > maxBytes || chunks.length >= maxChunks) limited = true;
          else { chunks.push(structuredClone(c)); bytes += size; }
        }
        if (c.type === "finish" && !["error", "aborted"].includes(c.reason?.kind)) {
          const result = limited ? { ok: false, issues: [{ rule: "stream-limit", severity: "warn", trigger: "buffer-limit" }], matches: [] }
            : checkStreamChunks(chunks, evidence ?? collectAnswerEvidence(messages, { maxResults }), assemble);
          log({ ...result, mode: "warn", blocked: false });
          if (result.issues.length && !hasTools) {
            yield* textChunks("\n\n" + answerGateNotice(result.issues), nextIndex++);
            const { replayState, ...finish } = c;
            yield finish;
          } else yield c;
        } else yield c;
        pending = iterator.next();
      }
      return;
    }
    while (true) {
      signal?.throwIfAborted?.();
      let timer;
      const overLimit = bytes > maxBytes || chunks.length >= maxChunks;
      const result = overLimit ? timeout : await wait(Promise.race([pending, new Promise((r) => { timer = setTimeout(() => r(timeout), Math.max(0, deadline - Date.now())); })])).finally(() => clearTimeout(timer));
      if (result === timeout || bytes > maxBytes || chunks.length >= maxChunks) {
        const issues = [{ rule: "stream-limit", severity: "warn", trigger: overLimit ? "buffer-limit" : "timeout" }];
        log({ ok: false, mode: "warn", issues, matches: [] });
        const bufferedFinish = chunks.findLast((c) => c.type === "finish");
        yield* chunks.filter((c) => c.type !== "finish");
        // Messages requires tool_use to remain the final assistant blocks.
        // Audit tool-bearing responses without appending synthetic text to them.
        let hasTools = chunks.some((c) => c.blockType === "tool-call" || c.block?.type === "tool-call");
        const finish = (c) => {
          if (hasTools || ["error", "aborted"].includes(c.reason?.kind)) return c;
          const { replayState, ...clean } = c;
          return clean;
        };
        let item = result === timeout ? await wait(pending) : result, noticed = false;
        while (!item.done) {
          signal?.throwIfAborted?.();
          const c = item.value;
          if (c.blockType === "tool-call" || c.block?.type === "tool-call") hasTools = true;
          if (Number.isInteger(c.index)) nextIndex = Math.max(nextIndex, c.index + 1);
          if (c.type === "finish") {
            if (!hasTools && !["error", "aborted"].includes(c.reason?.kind)) yield* textChunks("\n\n" + answerGateNotice(issues), nextIndex++);
            noticed = true;
          }
          yield c.type === "finish" ? finish(c) : c;
          pending = iterator.next();
          item = await wait(pending);
        }
        if (!noticed) {
          if (!hasTools && !["error", "aborted"].includes(bufferedFinish?.reason?.kind)) yield* textChunks("\n\n" + answerGateNotice(issues), nextIndex);
          if (bufferedFinish) yield finish(bufferedFinish);
        }
        return;
      }
      if (result.done) break;
      const c = structuredClone(result.value);
      chunks.push(c); bytes += Buffer.byteLength(JSON.stringify(c));
      if (Number.isInteger(c.index)) nextIndex = Math.max(nextIndex, c.index + 1);
      pending = iterator.next();
    }
    signal?.throwIfAborted?.();
    const terminal = chunks.findLast((c) => c.type === "finish");
    if (["error", "aborted"].includes(terminal?.reason?.kind)) { yield* chunks; return; }
    evidence ??= collectAnswerEvidence(messages, { maxResults });
    const final = checkStreamChunks(chunks, evidence, assemble);
    const issues = final.issues;
    const blocked = mode === "block" && issues.some((i) => i.severity === "block");
    log({ ok: !issues.length, mode, blocked, issues, matches: final.matches });
    if (!issues.length) { yield* chunks; return; }
    const textIndexes = new Set(chunks.filter((c) => c.type === "text-delta" || c.blockType === "text" || c.block?.type === "text").map((c) => c.index));
    const replaced = new Set();
    for (const c of chunks) {
      if (c.type === "finish") continue;
      if (blocked && textIndexes.has(c.index) && ["block-start", "text-delta", "block-end"].includes(c.type)) {
        if (!replaced.has(c.index)) {
          yield* textChunks(replaced.size ? "" : answerGateNotice(issues, true), c.index);
          replaced.add(c.index);
        }
        continue;
      }
      yield c;
    }
    if (!blocked && !chunks.some((c) => c.blockType === "tool-call" || c.block?.type === "tool-call")) yield* textChunks("\n\n" + answerGateNotice(issues), nextIndex);
    if (terminal) { const { replayState, ...finish } = terminal; yield finish; }
  } finally {
    signal?.removeEventListener("abort", abort);
    void pending?.catch(() => {});
    try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* cleanup must not replace a provider error */ }
  }
}
