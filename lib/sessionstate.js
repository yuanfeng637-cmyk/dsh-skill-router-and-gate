/**
 * sessionstate.js — 闸门的**按会话状态**（v14.3，2026-10-08）
 *
 * 起因（外部评审第二轮，都对）：
 *   1. v14.2 只把"已加载技能/拦截计数"按 agent 分桶，**技能目录仍是全局一份 Set**，
 *      而每个会话的 pre-step 都会**覆盖**它 ⇒ 两个会话交错运行时：
 *        · A 的目录里没有某技能、B 的有 ⇒ 全局有 ⇒ A 被**误拦**（而 A 根本加载不了它，只能等 maxDeny）
 *        · A 的有、B 的没有 ⇒ 全局没有 ⇒ A 被**误放**（兜底① 直接放行）
 *      DSH 的目录确实按 `scope: agent` + cwd 给不同结果（skills.md 的 snapshot 参数）。
 *   2. 新加的状态 Map **没有上限/清理** ⇒ 长期运行、开很多会话会一直累积。
 *   3. "成功加载"的登记必须发生在 `tools/post-execute` 的 `next()` **之后** ——
 *      waterfall 后面的监听器仍可把结果 `block` 掉（PostToolDecision 有 block 分支）。
 *
 * 本模块**不 import 任何 DSH/Cordis 东西**（纯容器），因此可以离线单测。
 */
export const NOAGENT = "__noagent__";

export function createSessionState({ maxSessions = 64 } = {}) {
  const loaded = new Map(); // sid -> Set<skillName>（该会话**成功加载**的技能）
  const denies = new Map(); // sid -> Map<skill, 被拦次数>
  const catalog = new Map(); // sid -> Set<skillName>（该会话的目录里真实存在的技能）

  // 读接口的兜底一律**每次新建**：既不创建会话条目/不触发淘汰（v14.3 首版的 ensure() 会），
  // 也不给调用方一个"共享的可写对象"（首版用共享空集，结果被误写会污染所有会话）。
  const emptySet = () => new Set();
  const emptyMap = () => new Map();

  const bump = (map, sid) => {
    const v = map.get(sid);
    if (v !== undefined) { map.delete(sid); map.set(sid, v); } // 读/写即算最近使用
  };
  const evict = (map) => { while (map.size > maxSessions) map.delete(map.keys().next().value); };
  const ensure = (map, sid, make) => {
    let v = map.get(sid);
    if (v === undefined) { v = make(); map.set(sid, v); }
    bump(map, sid); evict(map);
    return v;
  };

  return {
    maxSessions,
    /** 会话键：优先 `exec.agent.id`（活契约 ToolExecutionInput.agent?: Agent），没有就归到一个桶。 */
    sidOf: (exec) => {
      const id = exec?.agent?.id;
      return typeof id === "string" && id ? id : NOAGENT;
    },
    /** 读：返回既有集合（不存在则返回共享空集，**不写入**）。 */
    loadedOf: (sid) => {
      const s = loaded.get(sid);
      if (s) bump(loaded, sid);
      return s ?? emptySet();
    },
    /** 读：同上。写拦截计数请用 `addDeny`。 */
    deniesOf: (sid) => {
      const m = denies.get(sid);
      if (m) bump(denies, sid);
      return m ?? emptyMap();
    },
    /** 读：该会话的目录（不存在则空集）。写请用 `setCatalog`。 */
    catalogOf: (sid) => {
      const s = catalog.get(sid);
      if (s) bump(catalog, sid);
      return s ?? emptySet();
    },
    /** 写：把某技能的拦截计数 +1（只有真拦下时才调）。返回新计数。 */
    addDeny: (sid, skill) => {
      const m = ensure(denies, sid, () => new Map());
      const n = (m.get(skill) ?? 0) + 1;
      m.set(skill, n);
      return n;
    },
    /** **覆盖**该会话的目录（每个 pre-step 调一次）。 */
    setCatalog: (sid, names) => {
      const s = new Set(names ?? []);
      catalog.set(sid, s); bump(catalog, sid); evict(catalog);
      return s;
    },
    /**
     * 登记"该会话成功加载了某技能"。**只在 `skill` 工具最终被接受且成功时调用**
     * （index.js 的 post-execute：`await next()` 之后再判）。
     * 返回 true 表示登记成功（空名字返回 false）。
     */
    markLoaded: (sid, name) => {
      const n = typeof name === "string" ? name.trim() : "";
      if (!n) return false;
      ensure(loaded, sid, () => new Set()).add(n);
      denies.get(sid)?.delete(n); // v14.1：确认加载后清掉**本会话**的拦截计数（不为此新建条目）
      return true;
    },
    /** 会话结束时清理（agent/disposed）。 */
    drop: (sid) => { loaded.delete(sid); denies.delete(sid); catalog.delete(sid); },
    /** 全会话合计的拦截计数（status 展示用）。 */
    denySummary: () => {
      const agg = new Map();
      for (const m of denies.values()) for (const [k, v] of m) agg.set(k, (agg.get(k) ?? 0) + v);
      return agg;
    },
    sizes: () => ({ loadedSessions: loaded.size, denySessions: denies.size, catalogSessions: catalog.size }),
  };
}
