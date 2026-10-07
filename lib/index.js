/**
 * dsh-skill-router-and-gate — Codex 式「技能选择」检索层，为 DeepSeek Harness 补上
 * 「该用哪个 skill」这一步。
 *
 * 背景（真实事故）：DSH 把完整技能清单推给模型，然后指望模型自己想起来调用。
 * 实测：本会话 77.6 MB 日志里，技能清单元数据从第一条消息就在，而我全程 0 次
 * 主动调用，直到 97.8% 处才第一次尝试。这不是机制缺失，是「自觉」不可靠。
 *
 * Codex 的做法（出处 ~/.codex/logs_2.sqlite，target
 * codex_skills_extension::shadow_selection_experiment，47 个 turn × 12 种方法）：
 * 每轮在 build_extension_turn_input_items 阶段跑一整套**检索**算法，而不是靠
 * 模型判断。实测各法命中率（命中>0 / 47）：
 *   task_context_fusion_v1                     40   ← 最好
 *   lru_plus_lexical_character_routing_v1      35
 *   lru_plus_character_routing_v1              35
 *   character_ngram_v1 / rrf_lexical_char_v1 /
 *   character_routing_card_v1                  33   ← 字基全面优于词基（CJK）
 *   weighted_lexical_v1 / multi_query_lexical  28
 *   fielded_bm25_v1 / routing_card_exact_v1    26
 *   lru_v1（单独）                              2   ← 只能当 tiebreaker
 *
 * v13（2026-10-07）改成「判定为主、词法为辅」：
 *   ① 判定层 = 一次进程内 `llm.stream`（见 lib/judge.js）：独立上下文、无会话、
 *      可 signal 取消。**不用真子 agent** —— 子会话自己也会跑 agent/pre-step，
 *      而现有契约里没有"跳过 router"的可靠标记，会形成回环。
 *   ② 词法 9 路降级为「影子 + 兜底」：只在判定员超时/报错/输出无效时兜底。
 *   ③ 会话级账本：`agent/pre-step` 的 messages 只是**本步领取的那批**（发射点
 *      原文 `messages: claimed`），所以"已加载就不推荐"必须自己按会话累积。
 *   ④ 运行时开关 `/skill-gate on|off|status|eval`，以及无污染标定入口。
 *
 * 详细取舍与证据见 README 的「v13」两节。
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  buildJudgeSystem,
  catalogEntries,
  parseJudgeOutput,
  renderCatalog,
  runJudge,
  tokensOf,
} from "./judge.js";
import { skillGateDecision } from "./skillgate.js";

export const name = "dsh-skill-router-and-gate";
export const inject = ["skills"];

/**
 * ⚠ 每次改代码就把它 +1。它会写进每一条 trace 行。
 *
 * 为什么需要它（真实教训，2026-10-06）：
 *   - profile 里的 `lib/index.js` 一度停在 18,905 B 而源码已 25,642 B（`write` 断开
 *     了 pnpm 的硬链接）；
 *   - 我以为 HMR 会热重载，**实测不会** —— 改完必须重启 DSH；
 *   - 结果我花了多轮去分辨"现在跑的到底是哪一版"。
 * 有了版本号，看一眼账本就知道，不用再猜。
 */
export const VERSION = 14;

/* ──────────────────────────── 配置 ──────────────────────────── */

const DEFAULTS = {
  enabled: true,        // 启动期总开关（活宿主里的开关是 /skill-gate off）
  topK: 3,              // 注入几条候选；也是判定员一次最多能给几条
  // ⚠ v13：词法层已降级为「影子 + 兜底」，这个门槛**只作用于兜底路径**
  // （判定员超时 / 报错 / 输出无效时才走到这里）。
  // 0.5 → 0.75 的依据只有一条实测：2026-10-07 那次真实假阳性（主题是本插件
  // 自身、56 字中文）的覆盖率是 0.731，0.75 正好挡住它。
  // **这是单个负例选出来的暂定值，不是校准完成的阈值** —— 待 hold-out 上
  // 报告误报/漏报后再定。**不要用 cosine，也不要先 max 归一化。**
  minScore: 0.75,
  rrfK: 20,             // RRF 常数（影子路径仍在用）
  descriptionMax: 400,  // 注入文案里每条候选截断
  catalogDescMax: 200,  // 判定员看到的每条目录描述截断（固定值，与 query 无关）
  judge: true,          // 是否启用判定层
  judgeRoute: null,     // {provider, model}；null = 跟随会话默认模型
  judgeTimeoutMs: 8000, // 判定墙钟上限（首次活运行时实测 1.81 s，8 s 余量充足）
  judgeMaxTokens: 1200, // ⚠ 首次活运行时教训（2026-10-07 19:31）：300 会被推理烧光
                        // （out=300 正好等于上限、finish=max-tokens、正文零字符 ⇒
                        // no-json-object）。deepseek 系会思考，输出预算必须留够。
  catalogFallback: true,// DSH 原生 <available_skills> 缺席时由 router 补一份
  suppressAfter: 2,     // 推荐过 N 次仍未被确认加载 ⇒ 本会话内不再推
  ledgerMaxSessions: 64,
  includeLoaded: false, // 已在会话里加载过的 skill 是否还推荐
  // ── v14 技能闸（见 lib/skillgate.js）──
  skillGate: true,       // 要解析受管格式（xlsx/docx/pptx/pdf/csv-tsv）却没加载对应技能 → 拦
  skillGateMaxDeny: 3,   // 同一技能拦够 N 次就放行（防"加载一直没成功"把主流程卡死）
};

function readConfig() {
  const cfg = { ...DEFAULTS };
  const env = (key, cast) => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return undefined;
    try { return cast(raw); } catch { return undefined; }
  };
  const t = env("DSH_SKILL_GATE_TOPK", Number);
  if (Number.isFinite(t) && t >= 0) cfg.topK = Math.floor(t);
  const m = env("DSH_SKILL_GATE_MIN_SCORE", Number);
  if (Number.isFinite(m)) cfg.minScore = m;
  if (env("DSH_SKILL_GATE_INCLUDE_LOADED", (v) => v === "1" || v === "true") === true) {
    cfg.includeLoaded = true;
  }
  const on = (v) => v === "1" || v === "true";
  const master = env("DSH_SKILL_GATE", on);
  if (master !== undefined) cfg.enabled = master;
  const judge = env("DSH_SKILL_GATE_JUDGE", on);
  if (judge !== undefined) cfg.judge = judge;
  const route = env("DSH_SKILL_GATE_JUDGE_ROUTE", String);
  if (route && route.includes("/")) {
    const i = route.indexOf("/");
    cfg.judgeRoute = { provider: route.slice(0, i), model: route.slice(i + 1) };
  }
  const jt = env("DSH_SKILL_GATE_JUDGE_TIMEOUT_MS", Number);
  if (Number.isFinite(jt) && jt >= 500) cfg.judgeTimeoutMs = Math.floor(jt);
  const jm = env("DSH_SKILL_GATE_JUDGE_MAX_TOKENS", Number);
  if (Number.isFinite(jm) && jm >= 64) cfg.judgeMaxTokens = Math.floor(jm);
  const cd = env("DSH_SKILL_GATE_CATALOG_DESC_MAX", Number);
  if (Number.isFinite(cd) && cd >= 40) cfg.catalogDescMax = Math.floor(cd);
  const cf = env("DSH_SKILL_GATE_CATALOG_FALLBACK", on);
  if (cf !== undefined) cfg.catalogFallback = cf;
  const sa = env("DSH_SKILL_GATE_SUPPRESS_AFTER", Number);
  if (Number.isFinite(sa) && sa >= 1) cfg.suppressAfter = Math.floor(sa);
  const sg = env("DSH_SKILL_GATE_SKILL_GATE", on);
  if (sg !== undefined) cfg.skillGate = sg;
  const gd = env("DSH_SKILL_GATE_SKILL_GATE_MAX_DENY", Number);
  if (Number.isFinite(gd) && gd >= 0) cfg.skillGateMaxDeny = Math.floor(gd);
  return cfg;
}

/* ─────────────────────── 文本与脚本处理 ─────────────────────── */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const ASCII_WORD = /[a-z0-9_][a-z0-9_.+-]*/gi;

function detectScript(s) {
  if (!s) return "none";
  let cjk = 0;
  let latin = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  if (cjk === 0 && latin === 0) return "none";
  if (cjk === 0) return "ascii_latin";
  if (latin === 0) return "cjk";
  return "mixed";
}

function normalize(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 词级 token：ASCII 词 + CJK 单字（用于词袋类打分） */
function wordTokens(s) {
  const out = [];
  const t = normalize(s);
  for (const m of t.matchAll(ASCII_WORD)) out.push(m[0]);
  for (const ch of t) if (CJK.test(ch)) out.push(ch);
  return out;
}

/**
 * 字级 token：CJK 二元组 + ASCII 词。
 * Codex 实测字基方法对 CJK 全面优于词基（33–35 vs 26–28 命中），
 * 因为中文没有空格、分词不可靠。这里照做。
 */
function charTokens(s) {
  const out = [];
  const t = normalize(s);
  const chars = [...t];
  for (let i = 0; i < chars.length - 1; i += 1) {
    const a = chars[i];
    const b = chars[i + 1];
    if (CJK.test(a) || CJK.test(b)) out.push(a + b);
  }
  for (const m of t.matchAll(ASCII_WORD)) if (m[0].length > 1) out.push(m[0]);
  return out;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const tk of tokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
  return tf;
}

/* ─────────────────────── 分句（多查询用） ─────────────────────── */

function splitQueries(s) {
  const parts = String(s ?? "")
    .split(/[\n。；;！!？?]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  return parts.length > 0 ? parts : [String(s ?? "")];
}

/* ─────────────────── skill 路由卡（routing card） ─────────────────── */

/**
 * 把一份 skill 元数据压成「路由卡」。
 *
 * ⭐ 关键事实（读 `dsh-tool-skill/lib/index.js` L42–47 得出）：
 *   `catalogSourceEntries()` **只抽取 name 和 description** ——
 *   ```js
 *   skills.map((skill) => ({ name: skill.name,
 *                            description: catalogDescription(skill.description, max) }))
 *   // 渲染： `- \`${name}\`: ${description}`
 *   ```
 *   ⇒ **模型看到的目录里没有 `whenToUse`，也没有 `metadata`。**
 *
 * ⇒ 于是有了一个远比"全塞进 description"更好的分工：
 *
 *   | 字段 | 谁读 | 该放什么 |
 *   |---|---|---|
 *   | `description` | **模型** | 短、人话、一句 |
 *   | `whenToUse` | **只有路由** | 触发词，**零上下文成本** |
 *   | `metadata.routing` | **只有路由** | 关键词表（字符串或数组），**模型永远看不到** |
 *
 * 三者都参与打分；把触发词放在后两个字段，既提高命中率又不占模型上下文。
 * 注意：`.dsh`/`.agents` 下的 skill，front matter 只支持
 * `name` `description` `whenToUse` `metadata` `disable-model-invocation` `user-invocable`；
 * 写成 `modelInvocable` / `userInvocable` / `disableModelInvocation` 会让**整个 skill 被忽略**。
 */
function routingCard(skill) {
  const when = normalize(skill.whenToUse ?? "");
  const desc = normalize(skill.description ?? "");
  const clauses = [];
  const m = desc.match(/use (?:this )?(?:skill )?when([^.;]*)/);
  if (m) clauses.push(m[1]);

  // ⭐ metadata.routing：只给路由用的关键词表。接受数组或字符串。
  const md = skill.metadata && typeof skill.metadata === "object" && !Array.isArray(skill.metadata)
    ? skill.metadata
    : {};
  const rawRouting = Array.isArray(md.routing)
    ? md.routing.filter((x) => typeof x === "string").join(" ")
    : (typeof md.routing === "string" ? md.routing : "");
  const routingKeys = normalize(rawRouting);

  return {
    name: normalize(skill.name ?? ""),
    when,
    routingKeys,
    desc,
    clauses: clauses.join(" "),
  };
}

function cardText(card) {
  // routingKeys 与 when 权重相同；name 另由字基打分器重复一次以加重。
  return [card.name.replace(/[-_]/g, " "), card.when, card.routingKeys, card.clauses, card.desc].join(" ");
}

/* ───────────────────────── 各路打分器 ───────────────────────── */
/* 每个打分器返回 Map<skillName, score>；分数无需同尺度，融合用 RRF。 */

/** 1. weighted_lexical_v1：词袋重叠，name 权重最高 */
function scoreWeightedLexical(query, cards) {
  const qtf = termFreq(wordTokens(query));
  const out = new Map();
  for (const card of cards) {
    const nameTf = termFreq(wordTokens(card.name));
    const restTf = termFreq(wordTokens(card.when + " " + card.clauses + " " + card.desc));
    let s = 0;
    for (const [tk, qn] of qtf) {
      s += qn * ((nameTf.get(tk) ?? 0) * 4 + (restTf.get(tk) ?? 0));
    }
    if (s > 0) out.set(card.name, s);
  }
  return out;
}

/** 2. fielded_bm25_v1：分字段 BM25（name / whenToUse / description） */
function scoreFieldedBm25(query, cards) {
  const fields = [
    { w: 5, get: (c) => c.name },
    { w: 3, get: (c) => c.when },
    { w: 1, get: (c) => c.clauses + " " + c.desc },
  ];
  const qtf = termFreq(wordTokens(query));
  const out = new Map();
  const k1 = 1.2;
  const b = 0.75;
  for (const card of cards) {
    let s = 0;
    for (const f of fields) {
      const toks = wordTokens(f.get(card));
      if (toks.length === 0) continue;
      const tf = termFreq(toks);
      const avg = 40; // 固定近似长度，避免跨字段归一化噪声
      for (const [tk, qn] of qtf) {
        const f1 = tf.get(tk);
        if (!f1) continue;
        const denom = f1 + k1 * (1 - b + (b * toks.length) / avg);
        s += f.w * qn * ((f1 * (k1 + 1)) / denom);
      }
    }
    if (s > 0) out.set(card.name, s);
  }
  return out;
}

/** 3. character_ngram_v1：字级 2-gram 余弦（CJK 主力） */
function scoreCharacterNgram(query, cards) {
  const q = termFreq(charTokens(query));
  if (q.size === 0) return new Map();
  const qNorm = Math.sqrt([...q.values()].reduce((a, v) => a + v * v, 0));
  const out = new Map();
  for (const card of cards) {
    const c = termFreq(charTokens(cardText(card)));
    if (c.size === 0) continue;
    let dot = 0;
    for (const [tk, qv] of q) {
      const cv = c.get(tk);
      if (cv) dot += qv * cv;
    }
    if (dot <= 0) continue;
    const cNorm = Math.sqrt([...c.values()].reduce((a, v) => a + v * v, 0));
    out.set(card.name, dot / (qNorm * cNorm));
  }
  return out;
}

/** 4. multi_query_lexical_v1：按标点/换行切句，各句独立打分再相加 */
function scoreMultiQueryLexical(query, cards) {
  const merged = new Map();
  for (const part of splitQueries(query)) {
    for (const [k, v] of scoreWeightedLexical(part, cards)) {
      merged.set(k, (merged.get(k) ?? 0) + v);
    }
  }
  return merged;
}

/** 5. routing_card_exact_v1：query 是否命中路由卡关键词（精确子串） */
function scoreRoutingCardExact(query, cards) {
  const q = normalize(query);
  const out = new Map();
  for (const card of cards) {
    let s = 0;
    const keys = [
      ...card.name.split(/[-_]/),
      ...wordTokens(card.when).filter((t) => t.length >= 2),
    ];
    for (const k of new Set(keys)) {
      if (k.length >= 2 && q.includes(k)) s += k.length;
    }
    if (s > 0) out.set(card.name, s);
  }
  return out;
}

/** 6. character_routing_card_v1：路由卡的字级余弦（含 name 与 whenToUse） */
function scoreCharacterRoutingCard(query, cards) {
  const q = termFreq(charTokens(query));
  if (q.size === 0) return new Map();
  const qNorm = Math.sqrt([...q.values()].reduce((a, v) => a + v * v, 0));
  const out = new Map();
  for (const card of cards) {
    const text = card.name + " " + card.name + " " + card.when; // name 重复一次加重
    const c = termFreq(charTokens(text));
    if (c.size === 0) continue;
    let dot = 0;
    for (const [tk, qv] of q) {
      const cv = c.get(tk);
      if (cv) dot += qv * cv;
    }
    if (dot <= 0) continue;
    const cNorm = Math.sqrt([...c.values()].reduce((a, v) => a + v * v, 0));
    out.set(card.name, dot / (qNorm * cNorm));
  }
  return out;
}

/**
 * 7. lru_v1：最近在本次会话里被调用过的 skill 略微加分。
 * Codex 实测单独用几乎无效（2/47），只能当 tiebreaker —— 这里只给极小权重，
 * 且由 includeLoaded 控制是否把「已加载」的直接剔除。
 */
function scoreLru(cards, recentNames) {
  const out = new Map();
  let i = 0;
  for (const n of recentNames) {
    out.set(n, 1 / (1 + i));
    i += 1;
  }
  for (const card of cards) if (out.has(card.name)) out.set(card.name, out.get(card.name));
  return out;
}

/**
 * 高频虚词字。只由这些字组成的字组不算"证据"。
 * 标定依据（离线实测）：
 *   「午饭吃什么」唯一命中的字组是「什么」（来自 claim-check 的「为什么」），
 *   若不排除它，覆盖率会算成 1.000（假阳性）。
 *   「写论文的时候注意引用格式」唯一命中的是「论文」，必须算数。
 * 用"字组里至少有一个字不是虚词字"来区分这两类，比"至少命中 2 个字组"稳。
 */
const FUNCTION_CHARS = new Set(
  "的了着吗呢吧啊哦嗯是在有和就都也还又把被给让从对为以所而且或这那什么怎" +
  "样一不我你他她它们个些时候会能要想可好来去上下中个之与其因此但如若则于" +
  "很太更最再又已经过做说看点别没".split(""),
);

function isContentBigram(bg) {
  if (bg.length < 2) return false;
  for (const ch of bg) if (!FUNCTION_CHARS.has(ch)) return true;
  return false;
}

/**
 * 9. query_coverage_idf_v1：IDF 加权的**查询覆盖率**（短中文查询的主力）。
 *
 * 为什么不用余弦：`character_*_v1` 的分母是整张卡片的范数，卡片 300 字时一个
 * 3 字命中会被稀释到 ≈0（实测：「你确定吗」对着含「你确定」的卡片得 0.080，
 * 而噪声「午饭吃什么」得 0.070 —— 余弦无法区分）。覆盖率只看"查询里的字组
 * 有多少出现在卡片里"，不受卡片长度影响。
 *
 * ⚠ v6：**按句切块，取最高块**。整段算覆盖率时分母 = 查询总字组数 ⇒
 * **长输入被系统性压低**。实测：566 字的 goal 文本里明明有「有没有出处」，
 * 整段覆盖率只有 0.359（< 0.5 门槛）⇒ 不注入。按句切开后该块能打到很高。
 * Codex 的 `multi_query_*` 系列就是干这个的。
 */
function coverageOfText(query, cards, cardSets, idfFor) {
  const q = [...new Set(charTokens(query))];
  if (q.length === 0) return null;
  const idf = idfFor(q);
  // 只排除**虚词字组**（「什么」「这个」这类，防「午饭吃什么」的假阳性）。
  // df=0 的字组也排除出分母。
  //
  // ⚠ v7 曾试过把 df=0 的字组按"中性权重"计入分母，想把噪声长文本的假阳性
  // （0.727）压掉 —— **结果把正确匹配一起压掉了**：「用 RDP4 检测重组」
  // 「写论文的时候注意引用格式」全变成不注入（短查询里本来就夹着空格/ASCII
  // 相邻产生的垃圾字组，中性权重反而撑大分母）。已回退。
  //
  // ⚠ 已知代价（**故意接受**）：满篇未知词的文本分母偏小，可能假阳性。
  // 兜底在注入消息里写明：「不匹配就完全忽略这段，也不要提起它」。
  const effective = q.filter(
    (tk) => (idf.get(tk) ?? 0) > 0 && cardSets.some((s) => s.has(tk)) && isContentBigram(tk),
  );
  if (effective.length === 0) return null;
  const den = effective.reduce((a, tk) => a + idf.get(tk), 0);
  if (den <= 0) return null;
  const out = new Map();
  cardSets.forEach((set, i) => {
    let num = 0;
    let hits = 0;
    let cjkHit = false;
    for (const tk of effective) {
      if (!set.has(tk)) continue;
      num += idf.get(tk);
      hits += 1;
      if (CJK.test(tk)) cjkHit = true;
    }
    if (hits === 0) return;
    // ⚠ v9：**要求至少 2 个实词命中；只命中 1 个时，那一个必须是中文。**
    // 起因（真实事故）：用户粘贴一段 PowerShell 会话（含 `PS C:\Windows\System32>`、
    // `.dsh\skill-gate-trace.ndjson` 这类很短的块），块里实词只有一两个，
    // 命中一个覆盖率就是 1.000 ⇒ 冒出 `diagnose-windows-sandbox-acl`（靠 "Windows"）
    // 与 `loopx`（靠 "dsh"）两个假阳性。
    // 而「写论文的时候注意引用格式」只命中「论文」一个，**必须保住** ⇒ 用"是否中文"区分：
    // 单个中文实词（论文/清理/重组/出处）算数，单个英文单词（windows/dsh）不算。
    if (hits < 2 && !cjkHit) return;
    out.set(cards[i].name, num / den);
  });
  return out.size ? out : null;
}

function scoreQueryCoverage(query, cards) {
  const cardSets = cards.map((c) => new Set(charTokens(cardText(c))));
  const N = cards.length;
  const idfFor = (q) => {
    const m = new Map();
    for (const tk of q) {
      let df = 0;
      for (const set of cardSets) if (set.has(tk)) df += 1;
      m.set(tk, Math.log(1 + N / (1 + df)));
    }
    return m;
  };

  // 整段算一次（短查询就等于它）
  const merged = new Map(coverageOfText(query, cards, cardSets, idfFor) ?? []);
  // 再按句/换行切块，逐块算，每张卡片取最高值
  const chunks = String(query ?? "")
    .split(/[\n。；;！!？?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  for (const chunk of chunks) {
    const c = coverageOfText(chunk, cards, cardSets, idfFor);
    if (!c) continue;
    for (const [nm, v] of c) if (v > (merged.get(nm) ?? 0)) merged.set(nm, v);
  }
  return merged;
}

/* ───────────────────── RRF 融合 + 任务上下文 ───────────────────── */

/** Reciprocal Rank Fusion：把多路排序合成一路，免受量纲影响 */
function rrf(lists, k) {
  const acc = new Map();
  for (const list of lists) {
    if (!list) continue;
    const ranked = [...list.entries()].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([name], idx) => {
      acc.set(name, (acc.get(name) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return acc;
}

/** 从 workspace 的 AGENTS.md 抽关键词，作为任务上下文（对应 Codex 的 task_context_fusion） */
async function taskContextTerms(cwd) {
  const terms = new Set();
  if (!cwd) return terms;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(cwd, "AGENTS.md");
    const text = await fs.readFile(file, "utf8");
    if (text.length > 200000) return terms;
    for (const m of normalize(text).matchAll(/[\u4e00-\u9fff]{2,8}|[a-z][a-z0-9_.+-]{3,}/gu)) {
      terms.add(m[0]);
    }
  } catch {
    /* 没有 AGENTS.md 就退化为只用 query */
  }
  return terms;
}

/** 8. task_context_fusion_v1：query + 任务上下文一起打分（Codex 里命中率最高的那一路） */
function scoreTaskContextFusion(query, cards, contextTerms) {
  const ctxText = [...contextTerms].slice(0, 400).join(" ");
  if (!ctxText) return scoreCharacterRoutingCard(query, cards);
  const q = termFreq(charTokens(query + " " + ctxText));
  const qNorm = Math.sqrt([...q.values()].reduce((a, v) => a + v * v, 0));
  if (qNorm === 0) return new Map();
  const out = new Map();
  for (const card of cards) {
    const c = termFreq(charTokens(cardText(card)));
    if (c.size === 0) continue;
    let dot = 0;
    for (const [tk, qv] of q) {
      const cv = c.get(tk);
      if (cv) dot += qv * cv;
    }
    if (dot <= 0) continue;
    const cNorm = Math.sqrt([...c.values()].reduce((a, v) => a + v * v, 0));
    out.set(card.name, dot / (qNorm * cNorm));
  }
  return out;
}

/* ─────────────────────── 会话内已加载检测 ─────────────────────── */

const LOADED_RE = /<skill_content\s+name="([^"]+)"/g;
const ROUTING_NAME_RE = /- `([^`]+)` \(confidence /g;

/**
 * 找出**最近一次**已注入的候选块里的技能名。
 * 用来判断"最后一条消息是不是已经在推荐同一批"，而不是"和上一轮比"。
 */
function latestRoutingBlock(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      if (!part.text.includes("<candidate_skills>")) continue;
      return [...part.text.matchAll(ROUTING_NAME_RE)].map((m) => m[1]);
    }
  }
  return undefined;
}

function loadedSkillNames(messages) {
  const names = new Set();
  for (const msg of messages ?? []) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      if (!part.text.includes("<skill_content")) continue;
      for (const m of part.text.matchAll(LOADED_RE)) names.add(m[1]);
    }
  }
  return names;
}

/**
 * 取"这一轮用户实际说了什么"。
 *
 * ⚠ 不能只判 `role === "user"`。实测（2026-10-06，本会话 20,554 行日志）：
 * `role:"user"` 的消息有 **15 种 `source.kind`**：
 *   user 1049 · runtime-context 11 · goal 10 · compact-checkpoint 9 ·
 *   skill-catalog 6 · subagent-settled 6 · tool-jobs 4 · agent-instructions 4 ·
 *   agent-message 2 · user-approval 2 · tool-goal 2 · dsh-session-title-llm 1 ·
 *   skill-routing 1 · None 43
 * 只看 role 会把 **subagent 结果 / 后台任务通知 / runtime-context** 当成用户输入 ——
 * 实测就是这样路由错的：拿 `subagent-settled` 那段英文去匹配，命中了
 * `diagnose-windows-sandbox-acl`，而用户那一轮说的是「已经重启」。
 *
 * 所以只认 `source.kind === "user"`（真正的用户输入）；没有时退回 `goal`
 * （goal_round 的任务陈述，也是真实任务文本）。
 */
function lastUserText(messages) {
  const pick = (kinds) => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== "user") continue;
      if (!kinds.has(msg?.source?.kind)) continue;
      const content = msg?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text.trim().length > 0) return text;
    }
    return "";
  };
  return pick(new Set(["user"])) || pick(new Set(["goal"]));
}

/* ───────────────────────── 渲染候选 ───────────────────────── */

function renderShortlist(ranked, script) {
  const lines = ranked.map((r) => {
    const when = r.whenToUse ? ` — ${r.whenToUse}` : "";
    const desc = r.description ? `\n      ${r.description.slice(0, 400)}` : "";
    return `  - \`${r.name}\` (confidence ${(r.confidence ?? r.score).toFixed(3)})${when}${desc}`;
  });
  return [
    "<system-reminder>",
    "Skill routing (retrieval-based, not a judgement about your task).",
    `Query script detected: ${script}. Ranked candidates from the live catalog:`,
    "",
    "<candidate_skills>",
    ...lines,
    "</candidate_skills>",
    "",
    "If — and only if — a candidate's stated trigger matches what the user is asking for right now,",
    "call the `skill` tool with that exact name before taking task actions.",
    "Loading a skill is cheap and reversible; ignoring a matching one is the failure this list exists to prevent.",
    "If none of the candidates match, ignore this list entirely and do not mention it.",
    "</system-reminder>",
  ].join("\n");
}

/* ──────────────────── ② 破坏性操作的硬闸 ──────────────────── */

/**
 * 只拦**窄而高置信**的一类：递归强制删除，且目标落在"agent 自己的运行时/凭据/
 * 工具目录"里。设计取舍：
 *   - 不拦所有破坏性操作 —— 用户会明确要求清理磁盘，全部拦死会挡正经活。
 *   - 命中就 `deny`（不是 allow）—— 删错不可逆，拦错的代价只是多问一句。
 *
 * 事故来源：2026-10-06 有人把 `%USERPROFILE%\.cache\codex-runtimes` 当缓存删了，
 * 它其实是 `~/.codex/config.toml` L29–31 声明的 marketplace **源**。
 * ⇒ 教训写成了这条规则：**在 agent 自己的配置目录下，删东西必须被拦住。**
 */
/**
 * 只在命令**明确是递归/批量删除**时才算破坏性。
 *
 * ⚠ v8 收紧：最初写成"含 Remove-Item 就算"，结果**闸自己拦下了我清空一个日志文件**
 * （`Remove-Item ~/.dsh/skill-gate-trace.ndjson -Force`，落在保护区里）——
 * 删单个文件是合法日常动作，不该拦。
 * ⚠ v10：**必须"删除动词 + 递归标记"同时出现。**
 *   v8 只留了递归标记、去掉了删除动词，结果**闸拦下了只读命令**：
 *   `Get-ChildItem <~/.dsh/...> -Recurse -File`（我自己的同步脚本）就被拦了 ——
 *   因为命令里既有 `.dsh` 又有 `-Recurse`，而根本没有删除动作。
 *   v9 之前的老问题是反过来（只看动词，拦住了删单个文件）。
 *   两者都要，才既不误伤日常操作、又拦得住真实事故：
 *     事故那条 = `Remove-Item`（动词）+ `-Recurse`（递归）+ `.cache\codex-runtimes`（受保护）
 *     只读那条 = 没有动词 ⇒ 放行
 *     删单文件 = 有动词但**没有**递归标记 ⇒ 放行
 */
const DESTRUCTIVE = /(?:\bremove-item\b|\brm\b|\bdel\b|\berase\b|\brd\b|\brmdir\b)/i;
const RECURSIVE = /(?:-recurse\b|\brm\s+-[a-z]*r|\brd\s+\/s|\brmdir\s+\/s|\bdel\s+\/s|\berase\s+\/s|--recursive\b|\bfind\b[^|;]*?-delete|\bremove-item\b[^|;]*?-force[^|;]*?\\\*)/i;

const PROTECTED = [
  { re: /[\\/]\.codex(?:[\\/]|['"\s]|$)/i, what: "Codex 配置与凭据目录（~/.codex）" },
  { re: /[\\/]\.dsh(?:[\\/]|['"\s]|$)/i, what: "DSH 配置、profile 与会话（~/.dsh）" },
  { re: /[\\/]\.agents(?:[\\/]|['"\s]|$)/i, what: "共享 agent 配置与 skill（~/.agents）" },
  { re: /[\\/]\.local[\\/]bin(?:[\\/]|['"\s]|$)/i, what: "用户级可执行目录（~/.local/bin）" },
  { re: /AppData[\\/]Roaming[\\/]Tencent/i, what: "微信/腾讯数据目录" },
  { re: /AppData[\\/]Local[\\/]Packages[\\/]CanonicalGroupLimited/i, what: "WSL 发行版虚拟磁盘" },
  { re: /[\\/]\.ssh(?:[\\/]|['"\s]|$)/i, what: "SSH 密钥目录（~/.ssh）" },
  { re: /[\\/]\.git(?:[\\/]|['"\s]|$)/i, what: "git 仓库元数据（.git）" },
];

/**
 * 路径规范化 —— 必须做，否则匹配不上。
 * 命令参数经 JSON.stringify 后，反斜杠会变成**双反斜杠**：
 *   {"command":"Remove-Item 'C:\\Users\\...\\.cache\\codex-runtimes' -Force"}
 * 而配置文件里写的是单反斜杠。实测就是这一步让「查配置」这条规则漏掉了事故路径。
 * 统一：小写 → 去掉 \\?\ 前缀 → 所有 \ 折成 / → 折叠重复的 /。
 */
function normPath(s) {
  return String(s)
    .toLowerCase()
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/");
}

/**
 * 从命令文本里抽出候选路径（Windows 绝对路径 / ~ 路径 / 类 Unix 绝对路径）。
 * 用于"这个路径被谁引用"的查证。
 */
function extractPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s'"`;|)]+/g)) out.add(m[0]);
  for (const m of text.matchAll(/~[\\/][^\s'"`;|)]*/g)) out.add(m[0]);
  for (const m of text.matchAll(/\/(?:home|tmp|var|etc|usr|opt)\/[^\s'"`;|)]*/g)) out.add(m[0]);
  return [...out].map((p) => normPath(p.replace(/[\\/]+$/, "")));
}

/**
 * ⭐ 本闸的真正判据（不是硬编码路径表）：
 * **这个删除目标，是不是某个配置文件里写着的东西？**
 *
 * 来源：用户 AGENTS.md 的硬规则 ——「删或改任何文件前，先在配置文件里搜它被谁引用」。
 * 2026-10-06 的事故正是违反它：`~/.cache/codex-runtimes` 在
 * `~/.codex/config.toml` L29–31 里被声明为 marketplace **源**，我凭"它在 .cache 下"
 * 就当成缓存删了。硬编码一张禁区表挡不住这种事（那个路径当时不在表里），
 * 但"查配置"能挡住。
 */
let configCache = null; // { text, at }
async function configCorpus() {
  const now = Date.now();
  if (configCache && now - configCache.at < 60_000) return configCache.text;
  const parts = [];
  const candidates = [];
  try {
    const fs = await import("node:fs/promises");
    candidates.push(join(homedir(), ".codex", "config.toml"));
    candidates.push(join(homedir(), ".dsh", "AGENTS.md"));
    candidates.push(join(homedir(), ".agents", "AGENTS.md"));
    // profile 的 bundle/loader 配置
    const profRoot = join(homedir(), ".dsh", "profiles");
    for (const prof of await fs.readdir(profRoot).catch(() => [])) {
      for (const f of ["package.json", "cordis.yml", "cordis.patch.yml"]) {
        candidates.push(join(profRoot, prof, f));
      }
    }
    for (const p of candidates) {
      const t = await fs.readFile(p, "utf8").catch(() => null);
      if (t && t.length < 400_000) parts.push(t);
    }
  } catch { /* 读不到就算了，退化为只靠 PROTECTED */ }
  const text = normPath(parts.join("\n"));
  configCache = { text, at: now };
  return text;
}

/**
 * 返回 null 表示放行；返回字符串表示拦截原因。
 * 判定顺序：
 *   ① 不是能删东西的工具 → 放行
 *   ② 命令里没有递归/强制删除特征 → 放行
 *   ③ 命中已知禁区（PROTECTED）→ 拦
 *   ④ **删除目标出现在任一配置文件里 → 拦**（这才是通用规则）
 */
async function gateDecision(exec) {
  const name = exec?.name;
  if (typeof name !== "string") return null;
  if (!/^(pwsh|bash|workflow|run_code)$/.test(name)) return null;

  let text;
  try {
    const a = exec.arguments;
    text = typeof a === "string" ? a : JSON.stringify(a ?? "");
  } catch {
    return null;
  }
  // ⚠ v12：**按语句分别判定，不看整条命令。**
  //
  // 起因（连续三次误伤，都记在 README）：
  //   ① 一条命令里同时有「删 %TEMP%」和「提到 ~/.dsh/profiles」⇒ 整条被拦；
  //   ② 一条命令里同时有只读的 `Get-ChildItem -Recurse` 和删单文件的
  //      `Remove-Item $f -Force` ⇒ 整条被拦（`-Recurse` 和删除动词根本不属于同一个动作）；
  //   ③ 注释里写了触发词也被拦。
  // 根因：整条文本匹配会把**互不相关的片段**拼在一起判定。
  //
  // 现在只按 `;` 与换行切语句（**不切 `|`** —— 管道两端的 `Get-ChildItem -Recurse | Remove-Item`
  // 本来就应该算一个动作）。一个语句只有在**自己**同时具备删除动词与递归标记时才算破坏性，
  // 再只拿这个语句去比 PROTECTED。
  // ⚠ 参数经 JSON.stringify 后，换行是**字面的 `\n` 两个字符**（不是真换行），
  // 必须先还原 —— 否则按换行切语句切不开，判定又退回"整条文本"（实测就是这样漏的）。
  const unwrapped = String(text).replace(/\\r\\n|\\n|\\r/g, "\n");
  const stmts = unwrapped.split(/[;\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of stmts) {
    if (!DESTRUCTIVE.test(stmt) || !RECURSIVE.test(stmt)) continue;

    const hit = PROTECTED.find((p) => p.re.test(stmt));
    if (hit) {
      return `skill-gate 硬闸：这条命令看似会**递归删除**「${hit.what}」。` +
        `这是 agent 自己的运行时/凭据/数据目录，删错不可逆。` +
        `如果确实要删，请把目标逐个列出并说明理由；否则改用「先移到备份目录」。`;
    }

    // ④ 通用规则：删除目标是否被某个配置文件引用
    const paths = extractPaths(stmt);
    if (paths.length > 0) {
      const corpus = await configCorpus();
      if (corpus) {
        for (const p of paths) {
          if (corpus.includes(p)) {
            return `skill-gate 硬闸：删除目标 \`${p}\` **被某个配置文件引用** ` +
              `（查过 ~/.codex/config.toml 与 ~/.dsh/profiles/* 的 loader 配置）。` +
              `目录名带 cache 不等于它是缓存 —— 2026-10-06 就是照名字判断，` +
              `把 Codex 的 marketplace 源当缓存删了。` +
              `请先确认它到底被谁用；要清理就改成"移到备份目录"。`;
          }
        }
      }
    }
  }
  return null;
}

/* ─────────────── v13：账本 / 目录兜底 / 判定路由 的辅助 ─────────────── */

/** djb2 —— 只用于 trace 里的 query / catalog 指纹，不参与任何判断。 */
function hashText(s) {
  let h = 5381;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; i += 1) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * DSH 自己那份目录是否已经出现在本步骤可见的消息里。
 * 只看**不是我们发的**消息（我们的兜底 source.kind = "skill-catalog-fallback"）——
 * 否则会被自己的兜底骗过，原生目录一到也认不出来。
 */
function nativeCatalogPresent(messages) {
  for (const msg of messages ?? []) {
    if (msg?.source?.kind === "skill-catalog-fallback") continue;
    for (const part of msg?.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.includes("<available_skills>")) {
        return true;
      }
    }
  }
  return false;
}

/** 判定员用哪个模型：env 指定优先，否则跟随会话默认模型；**不传 reasoningEffort**（用 adapter 默认）。 */
function resolveJudgeRoute(ctx, cfg) {
  if (cfg.judgeRoute) return cfg.judgeRoute;
  try {
    const sel = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (sel && typeof sel.provider === "string" && typeof sel.model === "string") {
      return { provider: sel.provider, model: sel.model };
    }
  } catch { /* 拿不到就退化为不判定（走严格词法兜底） */ }
  return null;
}

/**
 * 会话账本。⚠ 只存技能名与计数，**不存用户原文**。
 * 状态只区分「已确认看到技能内容」（扫到 `<skill_content>`）与「推荐过几次」；
 * 不去猜"已请求加载"——那需要工具调用证据，本步骤的消息里看不到。
 */
function ledgerFor(state, sessionId, maxSessions) {
  let entry = state.ledger.get(sessionId);
  if (!entry) {
    entry = { confirmedLoaded: new Set(), recommended: new Map(), last: 0 };
    state.ledger.set(sessionId, entry);
  }
  entry.last = Date.now();
  if (state.ledger.size > maxSessions) {
    const drop = [...state.ledger.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, state.ledger.size - maxSessions);
    for (const [key] of drop) state.ledger.delete(key);
  }
  if (state.catalogPublished.size > maxSessions) {
    const keys = [...state.catalogPublished.keys()].slice(0, state.catalogPublished.size - maxSessions);
    for (const key of keys) state.catalogPublished.delete(key);
  }
  return entry;
}

/**
 * 中性注入文案（外部评审：不要给未校准的置信度，不要用"必须加载"的措辞）。
 * 保留 `<candidate_skills>` 这个标记：它同时是"别对自己的注入再注入"的判据。
 */
function renderRoutingBlock(picks) {
  return [
    "<system-reminder>",
    "Skill routing (a separate model call judged these candidates; it is not a judgement about your task).",
    "<candidate_skills>",
    ...picks.map((p) => `  - \`${p.name}\`${p.why ? ` — ${p.why}` : ""}`),
    "</candidate_skills>",
    "Load one with the `skill` tool if it applies to what you are about to do.",
    "If none of them applies, ignore this list entirely and do not mention it.",
    "</system-reminder>",
  ].join("\n");
}

/** 目录兜底：DSH 原生目录缺席时补一份（每会话一次 + digest 去重）。 */
function renderCatalogFallback(catalogPool, descMax) {
  const lines = catalogEntries(catalogPool, { descMax: Math.min(descMax, 160) }).map(
    (r) => `- \`${r.name}\`${r.description ? `: ${r.description}` : ""}`,
  );
  return [
    "<system-reminder>",
    "Skill catalog (DSH's own <available_skills> list has not appeared in this session; this snapshot comes from dsh-skill-router-and-gate. A later native catalog supersedes it.)",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "Load a skill with the `skill` tool using its exact name.",
    "</system-reminder>",
  ].join("\n");
}

/* ─────────────────────────── 插件本体 ─────────────────────────── */

export function apply(ctx) {
  const cfg = readConfig();
  const recent = []; // 进程内最近被推荐的 skill 名（影子路径的 LRU tiebreaker）
  // v13 运行时状态：只存技能名与计数，不存用户原文。
  const state = {
    enabled: cfg.enabled,
    ledger: new Map(), // sessionId -> { confirmedLoaded:Set, recommended:Map<name,count>, last }
    catalogPublished: new Map(), // sessionId -> digest
    loadedSkills: new Set(), // v14 技能闸：本会话已加载的技能（解锁条件）
    gateDenies: new Map(), // v14 技能闸：skill -> 被拦次数（兜底② 用）
    knownSkills: new Set(), // v14 技能闸：当前目录里真实存在的技能名（兜底① 用）
    // v14.1（GPT 评审：fail-open 不能静默）：把每种放行原因与闸自身故障都记下来，status 可见
    catalogReady: false, // 目录清单是否已就绪（false = 闸处于降级态，只是没拦而已）
    gateSkips: new Map(), // reason -> 次数（技能缺失 / giveup）
    gateErrors: 0, // 闸自身抛异常次数
    gateErrorLast: "", // 最近一次异常摘要
  };
  const killSwitchPath = join(homedir(), ".dsh", "skill-gate.off");

  // 追踪账本：每次 pre-step 都记一行（含"无匹配"及当时的最高覆盖率），用于
  //   ① 证明处理器真的跑了；
  //   ② 日后统计命中率、回看门槛是否合适（对应"半衰期"讨论里缺的度量层）。
  // 默认写到 ~/.dsh/skill-gate-trace.ndjson；设 DSH_SKILL_GATE_TRACE=0 关闭。
  const traceEnv = process.env.DSH_SKILL_GATE_TRACE;
  const tracePath = traceEnv === "0" || traceEnv === ""
    ? null
    : (typeof traceEnv === "string" ? traceEnv : join(homedir(), ".dsh", "skill-gate-trace.ndjson"));
  const trace = (obj) => {
    if (!tracePath) return;
    // 非阻塞、绝不影响主流程；失败静默。每条都带 v=<VERSION>，一眼看出跑的是哪版。
    void appendFile(
      tracePath,
      JSON.stringify({ t: new Date().toISOString(), v: VERSION, ...obj }) + "\n",
      "utf8",
    ).catch(() => {});
  };

  // ⭐ 启动即写一条。这样"新代码到底有没有被加载"可以**不等下一轮**就验证，
  // 也堵掉一个真实盲区：row 显示 `active`，但加载的可能是**旧版模块**
  // （profile 里一度停在 18,905 B，而源码已 25,642 B——write 断开了 pnpm 硬链接）。
  trace({
    stage: "apply",
    pid: process.pid,
    tracePath,
    topK: cfg.topK,
    minScore: cfg.minScore,
    judge: cfg.judge,
    judgeRoute: cfg.judgeRoute ? `${cfg.judgeRoute.provider}/${cfg.judgeRoute.model}` : null,
    judgeTimeoutMs: cfg.judgeTimeoutMs,
    judgeMaxTokens: cfg.judgeMaxTokens,
    catalogDescMax: cfg.catalogDescMax,
    catalogFallback: cfg.catalogFallback,
    suppressAfter: cfg.suppressAfter,
    promptVersion: JUDGE_PROMPT_VERSION,
    enabled: cfg.enabled,
  });

  /* ── v13：运行时开关 + 无污染标定入口 ──────────────────────────────────
   * `/skill-gate eval <fixtures.json>`：**直接调用判定 helper**，把固定样本、
   * 固定目录、固定提示词作为显式输入 —— 不经过 Agent，也就不存在"router 往判定
   * 会话里注入候选"的污染。这是外部评审给的无污染标定协议。
   */
  try {
    ctx.get("commands")?.register({
      name: "skill-gate",
      description: "skill-gate：on | off | status | eval <fixtures.json>",
      input: { hint: "on | off | status | eval <fixtures.json>" },
      handler: async ({ agent, rawInput, signal }) => {
        const parts = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        const sub = parts[0] ?? "status";
        if (sub === "off") {
          state.enabled = false;
          trace({ stage: "switch", enabled: false });
          return { kind: "success", text: "skill-gate：已关闭（本进程内立即生效；不写任何文件）。" };
        }
        if (sub === "on") {
          state.enabled = true;
          trace({ stage: "switch", enabled: true });
          return { kind: "success", text: "skill-gate：已开启。" };
        }
        if (sub === "status") {
          return {
            kind: "success",
            text: [
              `enabled=${state.enabled}　judge=${cfg.judge}　judgeRoute=${cfg.judgeRoute ? `${cfg.judgeRoute.provider}/${cfg.judgeRoute.model}` : "(跟随会话默认模型)"}`,
              `兜底门槛 minScore=${cfg.minScore}（暂定）　topK=${cfg.topK}　判定超时=${cfg.judgeTimeoutMs}ms　推荐压制阈值=${cfg.suppressAfter}`,
              `账本会话数=${state.ledger.size}　目录兜底记录=${state.catalogPublished.size}　提示词=${JUDGE_PROMPT_VERSION}　trace=${tracePath ?? "(已关闭)"}`,
              `技能闸=${cfg.skillGate ? "开" : "关"}（拦次上限 ${cfg.skillGateMaxDeny}）　目录清单=${state.catalogReady ? "ready" : "degraded：未就绪（此期间闸不拦）"}　本会话已加载=${state.loadedSkills.size ? [...state.loadedSkills].join(" ") : "无"}`,
              `　　已拦=${state.gateDenies.size ? [...state.gateDenies].map(([k, v]) => `${k}×${v}`).join(" ") : "无"}　放行=${state.gateSkips.size ? [...state.gateSkips].map(([k, v]) => `${k}×${v}`).join(" ") : "无"}　闸自身错误=${state.gateErrors}${state.gateErrorLast ? `（最近：${state.gateErrorLast}）` : ""}`,
            ].join("\n"),
          };
        }
        if (sub === "eval") {
          const file = parts.slice(1).join(" ").trim();
          if (!file) return { kind: "error", text: "用法：/skill-gate eval <fixtures.json>" };
          const llm = ctx.get("llm");
          const route = resolveJudgeRoute(ctx, cfg);
          if (!llm || !route) return { kind: "error", text: "没有 llm 服务或拿不到模型路由，无法评估。" };
          let fixtures;
          try {
            const fs = await import("node:fs/promises");
            fixtures = JSON.parse(await fs.readFile(file, "utf8"));
          } catch (error) {
            return { kind: "error", text: `读不了 fixtures：${error?.message ?? error}` };
          }
          if (!Array.isArray(fixtures)) return { kind: "error", text: "fixtures 必须是数组：[{id, query, expect:[names]}]" };
          const snapshot = await ctx.skills.snapshot({ cwd: agent?.session?.header?.cwd, signal, scope: agent });
          const catalogPool = (snapshot?.skills ?? []).filter((s) => s?.invocation?.modelInvocable !== false);
          const allowed = new Map(catalogPool.map((s) => [s.name.toLowerCase(), s.name]));
          const system = buildJudgeSystem(cfg.topK);
          const catalogText = renderCatalog(catalogEntries(catalogPool, { descMax: cfg.catalogDescMax }));
          const rows = [];
          for (const item of fixtures) {
            if (!item || typeof item.query !== "string") continue;
            let got = null;
            let err = null;
            let ms = null;
            try {
              const r = await runJudge({
                llm,
                route,
                system,
                prompt: buildJudgePrompt({ query: item.query, catalogText }),
                signal,
                maxTokens: cfg.judgeMaxTokens,
                timeoutMs: cfg.judgeTimeoutMs,
              });
              ms = r.ms;
              const parsed = parseJudgeOutput(r.text, allowed, { maxPicks: cfg.topK });
              if (parsed.ok) got = parsed.picks.map((p) => p.name);
              else err = parsed.reason;
            } catch (error) {
              err = String(error?.message ?? error);
            }
            const expect = Array.isArray(item.expect) ? item.expect : [];
            const g = new Set(got ?? []);
            const e = new Set(expect);
            rows.push({
              id: item.id ?? String(item.query).slice(0, 12),
              expect,
              got,
              err,
              ms,
              fp: [...g].filter((x) => !e.has(x)),
              fn: [...e].filter((x) => !g.has(x)),
            });
          }
          const invalid = rows.filter((r) => r.got === null).length;
          const fp = rows.reduce((a, r) => a + r.fp.length, 0);
          const fn = rows.reduce((a, r) => a + r.fn.length, 0);
          const exact = rows.filter((r) => r.got !== null && r.fp.length === 0 && r.fn.length === 0).length;
          for (const r of rows) {
            trace({ stage: "eval-case", id: r.id, expect: r.expect, got: r.got, err: r.err, ms: r.ms, catalog: catalogPool.length, promptVersion: JUDGE_PROMPT_VERSION });
          }
          trace({ stage: "eval-summary", n: rows.length, exact, fp, fn, invalid, catalog: catalogPool.length, model: `${route.provider}/${route.model}`, promptVersion: JUDGE_PROMPT_VERSION });
          return {
            kind: "success",
            text: [
              `判定离线评估：${rows.length} 例｜完全一致 ${exact}｜误报(多给) ${fp}｜漏报 ${fn}｜输出无效 ${invalid}`,
              `模型 ${route.provider}/${route.model}　目录 ${catalogPool.length} 份　提示词 ${JUDGE_PROMPT_VERSION}　（不经过 Agent，无 router 注入污染）`,
              ...rows.map((r) => `  ${r.got === null ? "无效" : r.fp.length || r.fn.length ? "偏差" : "一致"} ${r.id}　期望[${r.expect.join(",")}]　得到[${(r.got ?? []).join(",")}]${r.err ? `（${r.err}）` : ""}${r.ms ? `　${r.ms}ms` : ""}`),
            ].join("\n"),
          };
        }
        return { kind: "error", text: "用法：/skill-gate on | off | status | eval <fixtures.json>" };
      },
    });
  } catch { /* 没有 commands 服务也不影响路由本身 */ }

  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal?.throwIfAborted?.();

    // v13 运行时可关：/skill-gate off 立即生效；启动期用 DSH_SKILL_GATE=0。
    if (!state.enabled) {
      trace({ stage: "disabled" });
      return decision;
    }
    if (existsSync(killSwitchPath)) {
      trace({ stage: "kill-switch-file", path: killSwitchPath });
      return decision;
    }

    // 只有模型可调用的 skill 才参与路由
    const all = decision.messages ?? messages ?? [];
    const sessionId = String(agent?.id ?? "unknown-session");
    const ledger = ledgerFor(state, sessionId, cfg.ledgerMaxSessions);
    const alreadyLoaded = loadedSkillNames(all);
    for (const name of alreadyLoaded) ledger.confirmedLoaded.add(name);
    const query = lastUserText(all);
    const t0 = {
      step: typeof step === "number" ? step : null,
      session: sessionId.slice(0, 12),
      catalog: null,
      catalogComplete: null,
      catalogHash: null,
      queryLen: query?.length ?? 0,
      queryHash: hashText(query),
      promptVersion: JUDGE_PROMPT_VERSION,
      loaded: [...ledger.confirmedLoaded],
    };
    // 轮次门控：`messages` 只是本步领取的那批，所以"这一轮真的说了话"就等于
    // 这一步能取到用户文本。取不到 ⇒ 这是工具步/空步，不判定、不阻塞。
    if (!query || query.trim().length < 2) {
      trace({ ...t0, stage: "empty-query" });
      return decision;
    }
    if (query.includes("<candidate_skills>")) {
      trace({ ...t0, stage: "skip-self" });
      return decision; // 别对自己的注入再注入
    }

    const lookup = { cwd: agent?.session?.header?.cwd, signal, scope: agent };
    const snapshot = await ctx.skills.snapshot(lookup);
    const catalogPool = (snapshot?.skills ?? []).filter((s) => s?.invocation?.modelInvocable !== false);
    t0.catalog = catalogPool.length;
    t0.catalogComplete = snapshot?.complete ?? null;
    t0.catalogHash = hashText(catalogPool.map((s) => s.name).sort().join("|"));
    // v14 技能闸兜底①：记住"目录里真实存在哪些技能"，闸门只拦存在的技能。
    state.knownSkills = new Set(catalogPool.map((s) => s.name));
    state.catalogReady = state.knownSkills.size > 0;
    // ⚠ v13：`complete` 长期是 false（跨两天、跨会话实测）。契约原文只说它是
    // "discovery completed within a stable revision"，**不是**"目录只有一部分"的证据；
    // 本机 17 份 = 5 用户 + 8 LoopX + 3 office + 1 随包 sandbox，算术上就是全集。
    // 所以这里只**记录**完整性，不据此弃权 —— 弃权等于把判定层永久关掉。
    // （外部评审提醒"不能把部分目录当全量候选"；记录 + hold-out 验证是折中做法。）
    if (catalogPool.length === 0) {
      trace({ ...t0, stage: "empty-snapshot", complete: snapshot?.complete ?? null });
      return decision;
    }

    // 目录兜底：DSH 原生 <available_skills> 一直没出现时补一份（每会话一次 + digest 去重）
    const addons = [];
    if (cfg.catalogFallback && !nativeCatalogPresent(all)) {
      const digest = `${t0.catalogHash}:${catalogPool.length}`;
      if (state.catalogPublished.get(sessionId) !== digest) {
        state.catalogPublished.set(sessionId, digest);
        addons.push(
          createUserMessage({
            content: [{ type: "text", text: renderCatalogFallback(catalogPool, cfg.catalogDescMax) }],
            source: { kind: "skill-catalog-fallback", form: "catalog", entries: catalogPool.map((s) => ({ name: s.name })) },
          }),
        );
        trace({ ...t0, stage: "catalog-fallback", entries: catalogPool.length });
      }
    }
    const withAddons = (value) => (addons.length === 0 ? value : { ...value, messages: [...(value.messages ?? []), ...addons] });

    // 候选池：已确认加载过的不再推荐（includeLoaded 可关掉这条）
    const pool = catalogPool.filter((s) => cfg.includeLoaded || !ledger.confirmedLoaded.has(s.name));
    if (pool.length === 0) {
      trace({ ...t0, stage: "empty-pool" });
      return withAddons(decision);
    }

    const cards = pool.map((s) => ({ ...routingCard(s), whenToUse: s.whenToUse, description: s.description }));
    const contextTerms = await taskContextTerms(agent?.session?.header?.cwd);
    const script = detectScript(query);

    // 多路检索 —— 名字对齐 Codex 的 shadow 方法，便于日后对照
    const lists = [
      scoreWeightedLexical(query, cards),               // weighted_lexical_v1
      scoreFieldedBm25(query, cards),                   // fielded_bm25_v1
      scoreCharacterNgram(query, cards),                // character_ngram_v1
      scoreMultiQueryLexical(query, cards),             // multi_query_lexical_v1
      scoreRoutingCardExact(query, cards),              // routing_card_exact_v1
      scoreCharacterRoutingCard(query, cards),          // character_routing_card_v1
      scoreTaskContextFusion(query, cards, contextTerms), // task_context_fusion_v1
      scoreQueryCoverage(query, cards),                 // query_coverage_idf_v1
    ];
    // rrf_lexical_char_v1：只融合词基 + 字基两路
    lists.push(rrf([lists[0], lists[2]], cfg.rrfK));
    // lru_* 变体：在融合结果上叠一个极小的 LRU 加成
    const lruList = scoreLru(cards, recent);
    const fusedBase = rrf(lists, cfg.rrfK);
    const fused = new Map(fusedBase);
    for (const [n, v] of lruList) {
      fused.set(n, (fused.get(n) ?? 0) + v * 0.02);
    }

    // ⚠ v13：**不再**因为"词法没有任何信号"就提前返回 ——
    // 词法没信号恰恰是判定员该上场的情形（历史 164 条 trace 里 12/164 过门槛）。
    const max = Math.max(...fused.values(), 0);

    // ⚠ 门槛只认 `query_coverage_idf_v1`（lists[7]）。
    // 离线标定（12 条中文用例）：
    //   真匹配的覆盖率 = 0.500 ~ 1.000（claim-check / rdp4 / paper-cn / project-memory）
    //   噪声的覆盖率   = 无（今天天气 / 哈哈哈 / 午饭吃什么 / 把服务器上的链跑起来 / 随便聊聊）
    //   余弦系列无法分离：噪声「午饭吃什么」0.070 反而高于真例「你把我codex缓存删了」0.063。
    // 所以余弦只参与 RRF **排序**，不参与门槛判定。
    const coverage = lists[7];
    const absScore = (n) => {
      const v = coverage?.get?.(n);
      return typeof v === "number" ? v : 0;
    };

    // ── ③ 判定层（v13 主路径）────────────────────────────────────────────
    // 判定员的输入只有「本轮用户文本 + 一份与 query 无关的固定目录」；
    // **不把词法候选带进去**，免得拿旧 router 的结论锚定它。
    const lexicalTop = max > 0
      ? [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || absScore(b[0]) - absScore(a[0]))
        .slice(0, 5)
        .map(([n]) => n)
      : [];
    // 兜底清单：只在判定员超时/报错/输出无效时使用
    const fallbackRanked = max > 0
      ? [...fused.entries()]
        .map(([n, v]) => ({ n, v: v / max, abs: absScore(n) }))
        .filter((r) => r.abs >= cfg.minScore)
        .sort((a, b) => b.v - a.v || b.abs - a.abs)
        .slice(0, cfg.topK)
        .map((r) => {
          const card = cards.find((c) => c.name === r.n);
          return { name: card?.name ?? r.n, score: r.v, confidence: r.abs, why: "" };
        })
      : [];

    const allowed = new Map(cards.map((c) => [c.name.toLowerCase(), c.name]));
    const llm = ctx.get("llm");
    const route = resolveJudgeRoute(ctx, cfg);
    let judge = { decision: "fallback", picks: [], reason: cfg.judge ? "judge-unavailable" : "judge-disabled" };
    let judgeInfo = null;
    if (cfg.judge && llm && route && cards.length > 0) {
      const system = buildJudgeSystem(cfg.topK);
      const prompt = buildJudgePrompt({
        query,
        catalogText: renderCatalog(catalogEntries(pool, { descMax: cfg.catalogDescMax })),
      });
      try {
        const r = await runJudge({
          llm,
          route,
          system,
          prompt,
          signal,
          maxTokens: cfg.judgeMaxTokens,
          timeoutMs: cfg.judgeTimeoutMs,
        });
        judgeInfo = {
          model: `${route.provider}/${route.model}`,
          ms: r.ms,
          tokens: tokensOf(r.usage),
          timedOut: r.timedOut,
          finish: r.finish?.kind ?? null,
          // 诊断用：正文长度 vs 推理长度。首次活运行时就是靠它看出
          // "300 token 被推理烧光、正文一个字符都没有"。
          textLen: r.text.length,
          reasoningChars: r.reasoningChars ?? 0,
        };
        if (r.timedOut) {
          judge = { decision: "fallback", picks: [], reason: "judge-timeout" };
        } else {
          const parsed = parseJudgeOutput(r.text, allowed, { maxPicks: cfg.topK });
          if (parsed.ok) judge = { decision: parsed.decision, picks: parsed.picks, unknown: parsed.unknown, reason: null };
          else judge = { decision: "fallback", picks: [], reason: parsed.reason };
        }
      } catch (error) {
        judgeInfo = { model: `${route.provider}/${route.model}`, error: String(error?.message ?? error).slice(0, 200) };
        judge = { decision: "fallback", picks: [], reason: "judge-error" };
      }
    }
    signal?.throwIfAborted?.();

    // ── 决策 → 实际注入 ──────────────────────────────────────────────────
    // pick     ⇒ 用判定员的清单（再过滤：已确认加载过、以及推荐多次却从没被加载过的）
    // none     ⇒ **不注入**（合法的 none 必须保持为空）
    // unsure   ⇒ 弃权，不注入（v13 不升级子 agent，见 README）
    // fallback ⇒ 严格词法兜底（0.75 是暂定值，见 DEFAULTS 注释）
    let picks = [];
    let via = judge.decision;
    const suppressed = [];
    if (judge.decision === "pick") {
      for (const p of judge.picks) {
        if (ledger.confirmedLoaded.has(p.name)) continue;
        if ((ledger.recommended.get(p.name) ?? 0) >= cfg.suppressAfter) {
          suppressed.push(p.name);
          continue;
        }
        picks.push(p);
      }
      if (picks.length === 0) via = "none";
    } else if (judge.decision === "fallback") {
      picks = fallbackRanked;
      via = picks.length > 0 ? "lexical-fallback" : "none";
    }

    const topCov = [...(coverage?.entries?.() ?? [])].sort((a, b) => b[1] - a[1])[0];
    const tail = {
      ...t0,
      script,
      decision: judge.decision,
      via,
      judge: judgeInfo,
      judgeReason: judge.reason ?? null,
      lexicalTop,
      lexicalTopCoverage: lexicalTop.map((n) => Number(absScore(n).toFixed(3))),
      topCoverage: topCov ? { name: topCov[0], cov: Number(topCov[1].toFixed(3)) } : null,
      minScore: cfg.minScore,
      suppressed: suppressed.length > 0 ? suppressed : undefined,
      unknown: judge.unknown?.length ? judge.unknown : undefined,
    };

    if (picks.length === 0) {
      trace({ ...tail, stage: "none", injected: 0 });
      return withAddons(decision);
    }

    for (const p of picks) {
      ledger.recommended.set(p.name, (ledger.recommended.get(p.name) ?? 0) + 1);
      const i = recent.indexOf(p.name);
      if (i >= 0) recent.splice(i, 1);
      recent.unshift(p.name);
    }
    recent.length = Math.min(recent.length, 12);

    const injection = createUserMessage({
      content: [{ type: "text", text: renderRoutingBlock(picks) }],
      source: {
        kind: "skill-routing",
        form: "recommendation",
        entries: picks.map((p) => ({ name: p.name, confidence: p.confidence ?? null, why: p.why || null })),
        script,
        via,
        prompt: JUDGE_PROMPT_VERSION,
      },
    });

    trace({
      ...tail,
      stage: "injected",
      injected: picks.length,
      picked: picks.map((p) => p.name),
      why: picks.map((p) => p.why || null),
    });
    return { ...decision, messages: [...(decision.messages ?? []), injection, ...addons] };
  });
  // ── ② 破坏性操作的硬闸 ──────────────────────────────────────────────────
  // 契约（DSH Event.listEvents → tools/pre-execute，waterfall）：
  //   (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
  //   PreToolDecision = {kind:'allow'} | {kind:'deny',reason} | {kind:'cancel'}
  //                   | {kind:'ask',reason,displayReason}
  // 说明原文：「Allow, deny, cancel, or ask before dispatch. `next()` delegates to
  // allow；…missing approval support turns `ask` into denial.」
  // 本闸只对**窄而高置信**的一类返回 deny，其余一律 next() 放行。
  ctx.on("tools/pre-execute", async (exec, next) => {
    // v14 技能闸：先记「本会话加载过哪些技能」——这是闸门的解锁条件。
    try {
      if (exec?.name === "skill") {
        const n = exec?.arguments?.name;
        if (typeof n === "string" && n.trim()) state.loadedSkills.add(n.trim());
      }
    } catch { /* 记账失败不影响放行 */ }
    const loaded = new Set(state.loadedSkills);
    for (const e of state.ledger.values()) for (const n of e?.confirmedLoaded ?? []) loaded.add(n);
    // v14.1（GPT 评审）：技能**确认已加载**后，清掉它的拦截计数，
    // 否则"加载前拦了几次"会一直挂着，直到 maxDeny 把闸门降级。
    for (const n of loaded) state.gateDenies.delete(n);

    let reason = null;
    let deniedSkill = null;
    try {
      reason = await gateDecision(exec); // 删文件闸（v12）
    } catch {
      reason = null; // 闸自己出错时绝不放倒主流程（宁可放行）
    }
    if (!reason) {
      // 技能闸（v14）：三道兜底（技能缺失 / 拦够次数 / 关闸）由 skillgate.js 内部判，
      // 这里只负责计数、追踪与"拦还是放"。
      try {
        const d = skillGateDecision(exec, {
          loaded,
          known: state.knownSkills.size > 0 ? state.knownSkills : null,
          denies: state.gateDenies,
          maxDeny: cfg.skillGateMaxDeny,
          enabled: cfg.skillGate,
        });
        if (d?.action === "deny") {
          state.gateDenies.set(d.skill, (state.gateDenies.get(d.skill) ?? 0) + 1);
          deniedSkill = d.skill;
          reason = d.reason;
        } else if (d && d.action !== "off") {
          // v14.1：放行也要计数（GPT：「不要让 fail-open 变成无声放行」）
          const key = `${d.action}:${d.skill ?? "-"}`;
          state.gateSkips.set(key, (state.gateSkips.get(key) ?? 0) + 1);
          trace({
            stage: `gate-${d.action}`,
            tool: exec?.name,
            skill: d.skill,
            reason: String(d.reason ?? "").slice(0, 160),
          });
        }
      } catch (error) {
        // 闸自身出错：记下来再放行（绝不静默）
        state.gateErrors += 1;
        state.gateErrorLast = String(error?.message ?? error).slice(0, 120);
        trace({ stage: "gate-error", tool: exec?.name, reason: state.gateErrorLast });
      }
    }
    if (reason) {
      trace({ stage: "gate-deny", tool: exec?.name, skill: deniedSkill, reason: String(reason).slice(0, 200) });
      return { kind: "deny", reason };
    }
    return next();
  });
}

export default { name, inject, apply };
