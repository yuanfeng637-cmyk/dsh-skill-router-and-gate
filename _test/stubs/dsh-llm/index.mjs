/**
 * 测试桩：`@deepseek-ai/dsh-llm` 的**极小替身**（2026-10-08）
 *
 * 为什么需要：该包只存在于 DSH 的 app.asar 内，磁盘上无法解析 ⇒ 不在宿主里跑 `node --test` 会失败。
 * 本桩只实现插件真正用到的那一个导出：`createUserMessage`。
 * 语义按"原样透传字段"实现 —— 插件的注入消息要带上 `content` / `source`（DSH 侧再解释），
 * 所以桩不解析、不裁剪、不校验，只保证字段能原样传下去并被测试断言。
 */
export function createUserMessage(input) {
  const base = { role: "user" };
  if (input && typeof input === "object" && !Array.isArray(input)) return { ...base, ...input };
  return { ...base, content: input };
}
export default { createUserMessage };

// Loop request ownership and assembler subset used by the answer gate integration tests.
const loopRequests = new WeakSet();
export function markAgentLoopRequest(request) { loopRequests.add(request); return request; }
export function isAgentLoopRequest(request) { return loopRequests.has(request); }
export class BlockAssembler {
  partials = new Map();
  push(c) {
    if (c.index === undefined) return;
    const p = this.partials.get(c.index) ?? { type: c.blockType ?? c.type.replace(/-delta$/, ""), text: "" };
    if (c.type === "block-end") p.block = c.block;
    else if (!p.block && (c.type === "text-delta" || c.type === "reasoning-delta")) p.text += c.text;
    this.partials.set(c.index, p);
  }
  blocks() { return [...this.partials.values()].map((p) => p.block ?? { type: p.type, text: p.text }); }
}
