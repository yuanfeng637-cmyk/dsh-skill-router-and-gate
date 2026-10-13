/** Deterministic, opt-in project contracts. No LLM interpretation of prose. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, appendFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { commandText } from "./skillgate.js";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const SHELL = /^(pwsh|bash|workflow|run_code)$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMITS = { wallSeconds: 300, cpuSeconds: 1800, outputBytes: 100 * 1024 * 1024, networkRequests: 100 };
const TTL = 30 * 60 * 1000;
const nonempty = (v) => typeof v === "string" && !!v.trim();

export function resultText(result) {
  // Only actual text blocks; structuredContent and assistant assertions are not evidence.
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("\n").slice(0, 65536);
}

/** Narrow direct CLI grammar; quoted prose, remote wrappers and scripts are deliberately excluded. */
export function bioCommand(text) {
  const m = String(text).trim().match(/^(?:&\s*)?(mafft|iqtree(?:2|3)?)(?:\.exe)?\s+([^;\r\n|&]+)$/i);
  if (!m) return null;
  const args = m[2].trim();
  return { tool: m[1].toLowerCase(), help: /^(?:--help|-h)$/.test(args), probe: /^(?:--help|-h|--version|-version)$/.test(args) };
}

async function fileHash(path) {
  const before = await stat(path);
  if (!before.isFile()) throw new Error(`不是普通文件: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`哈希期间文件改变: ${path}`);
  return { path, sha256: hash.digest("hex"), bytes: after.size, modifiedAt: after.mtime.toISOString() };
}

function validatePolicy(p) {
  if (p?.version !== 1 || !Array.isArray(p.protect) || !p.protect.length || p.protect.length > 128 || !p.protect.every(nonempty)
      || !Array.isArray(p.actions) || p.actions.length > 128) throw new Error("策略须为 version=1，protect 非空字符串数组，actions 数组(≤128)");
  for (const a of p.actions) {
    if (!nonempty(a.command) || !Array.isArray(a.files) || a.files.length > 64 || !Array.isArray(a.assertions) || a.assertions.length > 64
        || !Array.isArray(a.rulings) || a.rulings.length > 16) throw new Error("action 缺 command/files/assertions/rulings 或超过数组上限");
    for (const f of a.files) {
      if (!nonempty(f.path) || !["input", "script", "reference", "output"].includes(f.role)
          || (f.role !== "output" && !HASH.test(f.sha256 ?? ""))) throw new Error("输入/脚本/引用须指定 path、role、sha256");
    }
    for (const r of a.rulings) {
      if (!nonempty(r.path) || !nonempty(r.quote) || !HASH.test(r.sha256 ?? "")
          || !Array.isArray(r.required) || !r.required.length || !r.required.every(nonempty)) throw new Error("裁定须含来源 path/sha256、原文 quote、required 参数片段");
    }
    for (const e of a.assertions) {
      if (!nonempty(e.command) || !nonempty(e.outputIncludes)) throw new Error("断言须含先前 command 和真实 outputIncludes");
    }
    if (!a.estimates || Object.keys(LIMITS).some((k) => !Number.isFinite(a.estimates[k]) || a.estimates[k] < 0)) throw new Error("estimates 必须显式给出四项非负估计；未知不能填 null");
    const expensive = Object.entries(LIMITS).some(([k, limit]) => a.estimates[k] >= limit);
    if (expensive && (!nonempty(a.hypothesis) || !nonempty(a.abortWhen) || !a.assertions.length)) throw new Error("昂贵动作缺 hypothesis、便宜验证 assertions 或 abortWhen");
    if (expensive && !a.files.some((f) => f.role === "input")) throw new Error("昂贵动作必须绑定至少一个输入 sha256");
  }
  return p;
}

export function createCompliance({ maxSessions = 64, auditPath, version, now = Date.now } = {}) {
  const sessions = new Map();
  const get = (sid) => {
    let s = sessions.get(sid);
    if (!s) s = { evidence: new Map(), pending: new Map(), help: new Map() };
    sessions.delete(sid); sessions.set(sid, s);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return s;
  };
  const audit = async (row) => {
    if (!auditPath) throw new Error("依从审计路径未配置");
    await appendFile(auditPath, JSON.stringify({ t: new Date(now()).toISOString(), v: version, ...row }) + "\n", "utf8");
  };
  const context = async (exec) => {
    const cwd = exec?.agent?.session?.header?.cwd;
    const configured = process.env.DSH_SKILL_GATE_POLICY;
    if (!configured) return { digest: "no-policy", policy: null, cwd };
    if (!isAbsolute(configured)) throw new Error("DSH_SKILL_GATE_POLICY 必须为绝对路径");
    const raw = await readFile(configured, "utf8");
    if (raw.length > 1024 * 1024) throw new Error("策略超过 1 MiB 字符上限");
    return { digest: sha256(raw), policy: validatePolicy(JSON.parse(raw)), cwd };
  };
  const pathOf = (path, cwd) => {
    if (!isAbsolute(path) && !cwd) throw new Error("相对文件路径缺 agent cwd");
    return isAbsolute(path) ? path : resolve(cwd, path);
  };
  const snapshots = async (files, cwd) => {
    const rows = [];
    for (const f of files.filter((f) => f.role !== "output")) {
      const row = await fileHash(pathOf(f.path, cwd));
      if (row.sha256 !== f.sha256) throw new Error(`来源/输入哈希不符: ${f.path}`);
      rows.push({ ...row, role: f.role, version: f.version ?? null, generatedAt: f.generatedAt ?? null, inputs: f.inputs ?? null });
    }
    return rows;
  };
  return {
    drop(sid) { sessions.delete(sid); },
    cancel(exec, sid) { sessions.get(sid)?.pending.delete(sha256(`${exec?.name}\n${commandText(exec)}`)); },
    async pre(exec, sid, loaded) {
      if (!SHELL.test(exec?.name ?? "")) return null;
      const command = commandText(exec);
      const bio = bioCommand(command);
      const s = get(sid);
      const key = sha256(`${exec.name}\n${command}`);
      try {
        // Checking every first direct use is conservative: uncertainty itself is unobservable.
        if (loaded.has("bioinformatics-toolkit") && bio && !bio.probe
            && now() - (s.help.get(bio.tool) ?? -Infinity) > TTL) {
          return { kind: "deny", reason: `依从闸：先单独执行 ${bio.tool} --help 并取得成功的非空帮助输出，再调用该工具。证据有效期 30 分钟。` };
        }
        const c = await context(exec);
        const protectedCall = !bio?.probe && c.policy?.protect.some((token) => command.includes(token));
        const a = protectedCall ? c.policy.actions.find((a) => a.command === command) : null;
        if ((protectedCall || bio?.help) && sid === "__noagent__") throw new Error("依从证据缺 agent.id，不能跨会话共享匿名桶");
        if (protectedCall && !a) throw new Error("受管动作未绑定精确 command；请先在项目策略登记参数、输入与验证");
        if (s.pending.has(key)) throw new Error("相同命令尚未返回结果；不能并发复用同一证据");
        let sources = [];
        if (a) {
          const files = sources = await snapshots(a.files, c.cwd);
          for (const r of a.rulings) {
            const path = pathOf(r.path, c.cwd);
            const raw = await readFile(path);
            if (sha256(raw) !== r.sha256 || !raw.toString("utf8").includes(r.quote)) throw new Error(`用户裁定原文/来源改变: ${r.path}`);
            if (r.required.some((value) => !command.includes(value))) throw new Error(`动作参数不符合用户裁定: ${r.quote}`);
          }
          for (const e of a.assertions) {
            const proof = s.evidence.get(sha256(`${exec.name}\n${e.command}`));
            if (!proof || proof.digest !== c.digest || now() - proof.at > TTL
                || !proof.output.includes(e.outputIncludes)
                || proof.files[a.command] !== JSON.stringify(files.map((f) => [f.path, f.sha256]))) throw new Error(`缺同会话、同策略、同输入的成功前置证据: ${e.command}`);
          }
          const warnings = [];
          for (const f of a.files.filter((f) => ["script", "reference"].includes(f.role))) {
            const generated = Date.parse(f.generatedAt);
            if (!nonempty(f.version) || !Number.isFinite(generated) || !Array.isArray(f.inputs) || !f.inputs.length
                || f.inputs.some((i) => !nonempty(i.path) || !HASH.test(i.sha256 ?? ""))) {
              warnings.push(`${f.path}: 缺版本/生成时间/输入来源；哈希吻合也不能证明无 bug`);
            } else if (now() - generated > 86400000 || generated > now()) {
              warnings.push(`${f.path}: 引用了超过24小时或时间在未来的来源，需核查适用性`);
            }
          }
          await audit({ stage: "compliance-preflight", session: sid, commandSha256: key, policySha256: c.digest,
            hypothesis: a.hypothesis ?? null, abortWhen: a.abortWhen ?? null, estimates: a.estimates, files, warnings });
        }
        // Store only calls needed for proofs/help/receipts, never all shell activity.
        const proofFor = c.policy?.actions.filter((a) => a.assertions.some((e) => e.command === command)) ?? [];
        if (a || proofFor.length || bio?.help) {
          if (s.pending.size >= 128) throw new Error("待返回动作超过 128；请结束或清理会话");
          const proofFiles = {};
          for (const action of proofFor) proofFiles[action.command] = JSON.stringify(
            (await snapshots(action.files, c.cwd)).map((f) => [f.path, f.sha256]));
          const outputBefore = {};
          for (const f of a?.files.filter((f) => f.role === "output") ?? []) {
            const path = pathOf(f.path, c.cwd);
            try { const st = await stat(path); outputBefore[path] = [st.size, st.mtimeMs]; }
            catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          s.pending.set(key, { ...c, action: a, bio, proofFiles, proofFor, sources, outputBefore, started: now() });
        }
        return null;
      } catch (error) {
        const reason = `依从闸：${error.message}`;
        try { await audit({ stage: "compliance-deny", session: sid, commandSha256: key, reason }); } catch { /* deny remains fail closed */ }
        return { kind: "deny", reason };
      }
    },
    async post(exec, result, decision, sid) {
      const s = sessions.get(sid);
      const key = sha256(`${exec?.name}\n${commandText(exec)}`);
      const p = s?.pending.get(key);
      if (!p) return;
      s.pending.delete(key);
      const output = resultText(result);
      const success = decision?.kind === "accept" && result?.isError === false && !!output.trim()
        && !/^\s*(?:Script|Process) running\b/im.test(output);
      const artifacts = [];
      let receiptError = null;
      if (p.action && success) {
        try {
          for (const f of p.action.files.filter((f) => f.role === "output")) {
            const path = pathOf(f.path, p.cwd);
            const st = await stat(path);
            const old = p.outputBefore[path];
            if (old && old[0] === st.size && old[1] === st.mtimeMs) throw new Error(`产物未更新，不能宣称本次生成: ${path}`);
            artifacts.push(await fileHash(path));
          }
          // Inputs/scripts changing during the action invalidate its provenance.
          await snapshots(p.action.files, p.cwd);
        } catch (error) { receiptError = error.message; }
      }
      let proofValid = success;
      try { for (const action of p.proofFor) await snapshots(action.files, p.cwd); }
      catch (error) { proofValid = false; receiptError = error.message; }
      await audit({ stage: "compliance-result", session: sid, commandSha256: key, policySha256: p.digest,
        accepted: decision?.kind === "accept", toolSuccess: result?.isError === false, evidence: success,
        receiptComplete: !!p.action && success && !receiptError && artifacts.length > 0,
        wallMs: now() - p.started, sources: p.sources, generatedAt: new Date(now()).toISOString(),
        outputExcerpt: output.slice(0, 2048), outputSha256: sha256(output),
        outputHashScope: "first-65536-text-characters", artifacts, receiptError });
      // Persist first: failed audit IO must never unlock a subsequent action.
      if (success && p.bio?.help && /(?:usage|options)\s*[:：]|--[a-z]/i.test(output)) s.help.set(p.bio.tool, now());
      if (proofValid && Object.keys(p.proofFiles).length) {
        s.evidence.set(key, { digest: p.digest, at: now(), output, files: p.proofFiles });
        while (s.evidence.size > 128) s.evidence.delete(s.evidence.keys().next().value);
      }
    },
  };
}
