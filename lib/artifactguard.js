/**
 * artifactguard.js — 「产物闸」（v19，2026-10-15）
 *
 * 起因（用户原话）：
 *   「对你这种破烂玩意，插件的约束还是太差了，必须有更多的强制机制」
 *   「继续转发，要求继续大量加强约束」
 *
 * 本模块把四类**真实发生过**的失败从"自觉"变成"闸门"，每条都是确定性判定，
 * 不做任何散文解释；内部异常一律放行（fail-open），只有命中规则才 deny：
 *
 *   R1 禁回收站：shell 命令把文件**移动**到垃圾/回收站类目录 ⇒ deny
 *      （对应裁定 no-recycle-bin：「删除不放回收站；彻底删除」）
 *   R2 产物登记：`write` 在项目内**新建**文件，但该路径既不是已登记动作的产物、
 *      也不在策略 artifact.allowNew / artifact.scratch 里 ⇒ deny
 *      （对应今天的失败：产出用户没要求的文件）
 *   R3 文体声明：`write` 的目标命中策略 artifact.genrePaths 时，正文开头必须出现
 *      `genre: <允许值>` ⇒ 否则 deny
 *      （对应今天的失败：把核验数字/内部版本史/软件默认行为写进"材料方法"正文）
 *   R4 交接前置：策略 artifact.requireReads 里的文件，本会话未读过时，
 *      **写操作**（write 与"已登记动作"的 shell 命令）一律 deny
 *      （对应今天的失败：整个会话没读 .ccm/PROGRESS.md 就一路写）
 *
 * 策略字段（全部可选，不影响 version=1 的既有校验）：
 *   "artifact": {
 *     "noRecycleBin": true,
 *     "requireReads": [".ccm/PROGRESS.md"],
 *     "allowNew":     ["analysis_set/*.tsv", "chikv1011/data/*.fasta"],
 *     "scratch":      ["tmp", "_scratch"],
 *     "genrePaths":   ["〈双星〉/METHODS*.md", "〈双星〉/README.md"]   ← 注释里不能出现「星号+斜杠」，故用〈双星〉代替
 *   }
 *
 * 设计边界（写清楚，免得当成 bug）：R4 是**会话级**而非"每轮"——插件看不到轮边界，
 * 只能判"本会话是否读过"。R2 只判**项目根内**的路径；项目外（临时目录等）不判。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { commandText, gateStatements } from "./skillgate.js";

const SHELL = /^(pwsh|bash|workflow|run_code)$/;
const WRITE_TOOL = /^(write|create_file)$/;
const MOVE_CMD = /(?:^|[;&|]\s*)(?:Move-Item|move|mv|robocopy|Copy-Item)\b/i;
const TRASH = /(?:^|[\\/\s"'])(?:_?trash|\.trash|trashcan|recycle(?:r|bin)?|回收站)(?:[\\/"'\s]|$)/i;
const GENRE_RE = /(?:^|\n)[\s>*#\-|]*(?:genre|文体|类型)\s*[:：]\s*([A-Za-z\u4e00-\u9fa5_-]+)/i;

/** 允许的文体值：写文档前必须显式声明，避免"正文/运行记录/表格"混在一份里。 */
export const GENRES = new Set([
  "methods", "methods-prose", "材料方法", "材料与方法", "方法",
  "runbook", "运行记录", "report", "报告", "notes", "笔记", "table", "表格", "data", "数据",
]);

/** 极简 glob：`**` 跨目录（`**​/` 可匹配零层目录）、`*` 不跨目录；大小写不敏感。 */
export function globToRe(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`, "i");
}

/** 读策略里的 artifact 段与已登记动作（读不到/格式不对一律返回 null ⇒ 闸门不生效）。 */
export async function loadPolicy(policyPath) {
  if (!policyPath) return null;
  try {
    const raw = await readFile(policyPath, "utf8");
    if (raw.length > 1024 * 1024) return null;
    const p = JSON.parse(raw);
    return { artifact: p?.artifact && typeof p.artifact === "object" ? p.artifact : null, actions: Array.isArray(p?.actions) ? p.actions : [] };
  } catch { return null; }
}

const deny = (rule, reason) => ({ kind: "deny", reason: `产物闸 ${rule}：${reason}` });

/** 读文件内容哈希：读取证据必须绑定内容（外部评审要求）。 */
async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/** 读取证据的键：`<绝对路径>#<内容sha256>`。只记完整读取，且内容变了就失效。 */
export const readKey = (absPath, sha256) => `${absPath}#${sha256}`;

export function createArtifactGuard({ policyPath } = {}) {
  const path = policyPath ?? process.env.DSH_SKILL_GATE_POLICY;
  return {
    /**
     * @param {{name?:string, arguments?:unknown, agent?:{session?:{header?:{cwd?:string}}}}} exec
     * @param {string} sid 会话键
     * @param {Set<string>} reads 本会话已成功读取的**绝对路径**集合
     * @returns {Promise<null | {kind:'deny', reason:string}>}
     */
    async pre(exec, sid, reads) {
      try {
        const name = exec?.name;
        const isShell = SHELL.test(name ?? "");
        const isWrite = WRITE_TOOL.test(name ?? "");
        if (!isShell && !isWrite) return null;
        const loadedPolicy = await loadPolicy(path);
        const art = loadedPolicy?.artifact;
        if (!art) return null; // 未声明 artifact 段 ⇒ 本闸不生效（向后兼容）
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        const abs = (p) => (isAbsolute(p) ? p : resolve(cwd, p));
        const relOf = (p) => relative(cwd, p).split(sep).join("/");
        const command = isShell ? commandText(exec) : "";

        // ── R1 禁回收站 ─────────────────────────────────────────────────────────
        if (isShell && art.noRecycleBin !== false) {
          for (const stmt of gateStatements(command)) {
            if (MOVE_CMD.test(stmt) && TRASH.test(stmt)) {
              return deny("R1", "命令把文件**移动**到垃圾/回收站类目录。按 no-recycle-bin 裁定必须彻底删除"
                + "（删前仍须核验路径/清单/引用/占用进程）；确需保留请先取得用户明确指令。");
            }
          }
        }

        // ── R4 交接前置（只对"写操作"生效：write 与已登记动作的 shell 命令）────────
        // 读取证据**绑定内容哈希**：只"哈希过/查过存在/读过一半"都不算；文件变了即失效。
        const need = Array.isArray(art.requireReads) ? art.requireReads : [];
        if (need.length) {
          const registered = isShell && loadedPolicy.actions.some((a) => a?.command === command);
          if (isWrite || registered) {
            for (const r of need) {
              const p = abs(r);
              if (!existsSync(p)) continue;             // 文件不存在 ⇒ 无对象可读，放行
              const key = readKey(p, await sha256File(p));
              if (!(reads instanceof Set) || !reads.has(key)) {
                return deny("R4", `本会话尚未**完整读取**过 ${r}（或读完之后文件已改变）。`
                  + `请先 read ${r}（不带 offset/limit），再原样重发这一条命令。只查哈希/只看存在均不算。`);
              }
            }
          }
        }

        // ── R5 参数闸：受管工具的数值参数必须等于当前有效裁定 ─────────────────────
        // 外部评审指出的漏洞：子串匹配（rulings.required）挡不住 "-T 32 -T 64" 与
        // "echo \"-T 32\"; iqtree3 … -T 64"。这里改为**逐条语句解析取值并做相等检查**。
        const guards = Array.isArray(art.paramGuards) ? art.paramGuards : [];
        if (isShell && guards.length) {
          const stmts = gateStatements(command);
          for (const guard of guards) {
            if (!guard || typeof guard.regex !== "string") continue;
            let toolRe;
            try { toolRe = new RegExp(guard.tool ?? ".", "i"); } catch { continue; }
            if (!stmts.some((s) => toolRe.test(s))) continue;
            let re;
            try { re = new RegExp(guard.regex, "gi"); } catch { continue; }
            const vals = [];
            for (const s of stmts) {
              let m;
              while ((m = re.exec(s)) !== null) {
                // 取**第一个有定义的捕获组**（多分支正则里未参与匹配的组是 undefined，不能回退成整段匹配）
                const captured = m.slice(1).find((x) => x !== undefined);
                vals.push(String(captured ?? m[0]));
                if (m.index === re.lastIndex) re.lastIndex += 1;
              }
            }
            const allowed = (Array.isArray(guard.allowed) ? guard.allowed : []).map(String);
            const name = guard.name ?? "参数";
            if (!vals.length) {
              if (guard.require === true) return deny("R5", `命令未显式给出${name}，而策略要求必须给出（允许：${allowed.join("/")}）。`);
              continue;
            }
            const bad = vals.filter((v) => !allowed.includes(v));
            if (bad.length || new Set(vals).size > 1) {
              return deny("R5", `${name}取值为「${vals.join(", ")}」，与当前有效裁定不符（允许值：${allowed.join(" / ")}）。`
                + "注意：引号内出现的同名字符串不能作为证据，重复参数一律拒绝。");
            }
          }
        }

        // ── R2 产物登记 + R3 文体声明（只对 write 生效）──────────────────────────
        if (isWrite) {
          const args = exec?.arguments ?? {};
          const target = args.file_path ?? args.filePath ?? args.path;
          if (typeof target !== "string" || !target.trim()) return null;
          const p = abs(target);
          const rel = relOf(p);
          const content = String(args.content ?? args.text ?? "");
          const allowNew = (Array.isArray(art.allowNew) ? art.allowNew : []).map(globToRe);
          const scratch = (Array.isArray(art.scratch) ? art.scratch : []).map(globToRe);
          const genrePaths = (Array.isArray(art.genrePaths) ? art.genrePaths : []).map(globToRe);
          if (!rel.startsWith("..") && !existsSync(p) && art.registerNew !== false) {
            const known = allowNew.some((re) => re.test(rel)) || scratch.some((re) => re.test(rel));
            if (!known) {
              return deny("R2", `项目内新文件 ${rel} 未在策略里登记（artifact.allowNew / artifact.scratch），`
                + "也不是任何已登记动作的产物。先在项目策略登记该产物路径，或在 scratch 目录里写。");
            }
          }
          if (genrePaths.some((re) => re.test(rel))) {
            const m = GENRE_RE.exec(content.slice(0, 2000));
            const genre = m ? m[1].toLowerCase() : "";
            if (!m || !GENRES.has(genre)) {
              return deny("R3", `目标 ${rel} 命中 artifact.genrePaths，但正文开头没有声明文体。`
                + `请在文件开头写一行 \`genre: <值>\`（允许：${[...GENRES].join(" / ")}），再写入。`);
            }
          }
        }
        return null;
      } catch {
        return null; // 闸自身出错绝不拦主流程（与其余闸门同一兜底策略）
      }
    },
  };
}
