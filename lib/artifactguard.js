/**
 * artifactguard.js — 「产物闸」（v20，2026-10-15）
 *
 * 起因（用户原话）：
 *   「对你这种破烂玩意，插件的约束还是太差了，必须有更多的强制机制」
 *   「继续转发，要求继续大量加强约束」　「继续优化，全改完再说」
 *   「grill me更是从来就没加载过」
 *
 * v20 共 8 条规则，全部确定性判定、不做散文解释；内部异常一律放行（fail-open），
 * 只有命中规则才 deny。规则与**真实发生过的失败**一一对应：
 *
 *   R1 禁回收站      : shell 把文件“移动”到垃圾/回收站类目录 ⇒ deny（裁定 no-recycle-bin）
 *   R2 产物登记      : write 在项目内新建未登记文件 ⇒ deny（产出用户没要求的文件）
 *   R3 文体声明      : 命中 specs/genrePaths 的文档必须声明允许的文体 ⇒ deny
 *                      （把核验数字/内部版本史/软件默认行为写进“材料方法”正文）
 *   R4 交接前置      : 本轮未**完整读取**（绑定内容哈希）requireReads ⇒ 拒绝写操作
 *                      （整会话没读 .ccm/PROGRESS.md 就一路写）
 *   R5 参数闸        : 受管工具数值参数必须等于有效裁定；重复/夹带都拒绝
 *                      （用户说 32 线程，我写了 -T 64）
 *   R6 路径别名      : 符号链接 / UNC 网络路径写入 ⇒ 拒绝（无法核对是否在授权集合内）
 *   R7 shell 写入登记: shell 里重定向/Out-File/Set-Content/New-Item 写项目内未登记路径 ⇒ 拒绝
 *                      （绕过 write 工具直接由命令写文件）
 *   R8 候选处置      : 路由注入的技能候选未加载、且命令未给出**枚举理由**的豁免 ⇒ 拒绝
 *                      （hyphy-pselection / project-memory / grill-me 从未加载）
 *
 * 策略字段（全部可选，兼容 version=1）：
 *   "artifact": {
 *     "noRecycleBin": true,
 *     "requireReads": [".ccm/PROGRESS.md"],
 *     "allowNew":     ["analysis_set/*.tsv"],
 *     "scratch":      ["tmp/**"],
 *     "genrePaths":   ["〈双星〉/METHODS*.md"],
 *     "specs":        [{"paths": ["〈双星〉/METHODS*.md"], "genre": ["methods"]}],
 *     "paramGuards":  [{"name":"线程数","tool":"iqtree3?|mafft","regex":"-T\\s+(\\d+)","allowed":["32"]}],
 *     "candidateReasons": ["covered_by", "not_installed", "user_waiver"]
 *   }
 *
 * 已知边界（外部评审 Codex 指出、插件层无法解决，写在这里免得被当成已强制）：
 *   · 只能拦住宿主暴露的入口（本插件覆盖 shell 与 write 工具）；**脚本内部的写/移动**拦不住；
 *   · 路径只做直接别名检查（符号链接/UNC/`..`），不处理父目录 junction、硬链接与检查-写入竞态；
 *   · R3 只强制“声明文体”，不校验自由文本的语义；R8 只强制“完成可验证处置”，不判断理由是否恰当。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { commandText, gateStatements } from "./skillgate.js";

const SHELL = /^(pwsh|bash|workflow|run_code)$/;
const WRITE_TOOL = /^(write|create_file)$/;
const MOVE_CMD = /(?:^|[;&|]\s*)(?:Move-Item|move|mv|robocopy|Copy-Item)\b/i;
const TRASH = /(?:^|[\\/\s"'])(?:_?trash|\.trash|trashcan|recycle(?:r|bin)?|回收站)(?:[\\/"'\s]|$)/i;
const GENRE_RE = /(?:^|\n)[\s>*#\-|]*(?:genre|文体|类型)\s*[:：]\s*([A-Za-z\u4e00-\u9fa5_-]+)/i;
const SKIP_RE = /\bSKIP\s+([A-Za-z0-9_.\-]+)\s+reason=([a-z_]+)/gi;
/** shell 侧写文件的形态（用于 R7；只做保守识别） */
const SHELL_WRITE = /(?:^|[;&|]\s*)(?:Out-File|Set-Content|Add-Content|New-Item|tee)\b|(?:[^"'\w])>{1,2}\s*/i;
const FILE_ARG = /(?:-FilePath|-Path|-LiteralPath|--file)\s+("[^"]+"|'[^']+'|[^\s;|&]+)/gi;
const REDIRECT_TARGET = /(?:[^"'\w])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g;

/** 允许的文体值（未在策略 specs 里单独指定时使用）。 */
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

/** 读取证据的键：`<绝对路径>#<内容sha256>`。只记完整读取，且内容变了就失效。 */
export const readKey = (absPath, sha256) => `${absPath}#${sha256}`;

async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/** 读策略里的 artifact 段与已登记动作（读不到/格式不对一律返回 null ⇒ 闸门不生效）。 */
export async function loadPolicy(policyPath) {
  if (!policyPath) return null;
  try {
    const raw = await readFile(policyPath, "utf8");
    if (raw.length > 1024 * 1024) return null;
    const p = JSON.parse(raw);
    return {
      artifact: p?.artifact && typeof p.artifact === "object" ? p.artifact : null,
      actions: Array.isArray(p?.actions) ? p.actions : [],
    };
  } catch { return null; }
}

const deny = (rule, reason) => ({ kind: "deny", reason: `产物闸 ${rule}：${reason}` });
const unquote = (s) => String(s ?? "").trim().replace(/^["']|["']$/g, "");

export function createArtifactGuard({ policyPath, clearPicks } = {}) {
  const path = policyPath ?? process.env.DSH_SKILL_GATE_POLICY;
  return {
    /**
     * @param {{name?:string, arguments?:unknown, agent?:{session?:{header?:{cwd?:string}}}}} exec
     * @param {string} sid 会话键
     * @param {{reads?:Set<string>, picks?:{names?:string[]}|null, loaded?:Set<string>}} ctx
     *        reads = 本轮已完整读取的键（`<路径>#<sha256>`）；picks = 本轮路由注入的候选
     * @returns {Promise<null | {kind:'deny', reason:string}>}
     */
    async pre(exec, sid, ctx = {}) {
      try {
        const { reads, picks, loaded } = ctx;
        const name = exec?.name;
        const isShell = SHELL.test(name ?? "");
        const isWrite = WRITE_TOOL.test(name ?? "");
        if (!isShell && !isWrite) return null;
        const lp = await loadPolicy(path);
        const art = lp?.artifact;
        if (!art) return null; // 未声明 artifact 段 ⇒ 本闸不生效（向后兼容）
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        const abs = (p) => (isAbsolute(p) ? p : resolve(cwd, p));
        const relOf = (p) => relative(cwd, p).split(sep).join("/");
        const command = isShell ? commandText(exec) : "";
        const allowNew = (Array.isArray(art.allowNew) ? art.allowNew : []).map(globToRe);
        const scratch = (Array.isArray(art.scratch) ? art.scratch : []).map(globToRe);
        const registered = (rel) => allowNew.some((re) => re.test(rel)) || scratch.some((re) => re.test(rel));

        // ── R8 候选处置（先于其余规则：先把“该加载的技能”结清）─────────────────────
        const pickNames = Array.isArray(picks?.names) ? picks.names.filter((n) => typeof n === "string" && n) : [];
        if (pickNames.length) {
          // 用户裁定（2026-10-15）：「没必要非要加载 grill me」⇒ 策略可用 candidateExempt 列出
          // 永不强制处置的候选（加载不是纠错机制，纠错靠自否审计与证据）。
          const exempt = new Set((Array.isArray(art.candidateExempt) ? art.candidateExempt : []).map(String));
          const pending = pickNames.filter((n) => !exempt.has(n) && (!(loaded instanceof Set) || !loaded.has(n)));
          if (pending.length) {
            const reasons = new Set((Array.isArray(art.candidateReasons) && art.candidateReasons.length
              ? art.candidateReasons : ["covered_by", "not_installed", "user_waiver"]).map(String));
            const waived = new Map();
            let m;
            SKIP_RE.lastIndex = 0;
            while ((m = SKIP_RE.exec(command)) !== null) waived.set(m[1], m[2]);
            const bad = pending.filter((n) => {
              const r = waived.get(n);
              if (!r || !reasons.has(r)) return true;
              if (r === "not_installed" && ctx.catalog instanceof Set && ctx.catalog.has(n)) return true; // 目录里有 ⇒ 理由不成立
              return false;
            });
            if (bad.length) {
              return deny("R8", `本轮路由注入的技能候选尚未处置：${bad.join(", ")}。`
                + `要么加载（skill(name="…")），要么在同一条命令里写豁免：`
                + `${bad.map((n) => `SKIP ${n} reason=covered_by|not_installed|user_waiver`).join(" ；")}。`
                + `（reason=not_installed 会被技能目录核对，谎报无效。）`);
            }
            if (typeof clearPicks === "function") clearPicks(sid);
          }
        }

        // ── R1 禁回收站 ─────────────────────────────────────────────────────────
        if (isShell && art.noRecycleBin !== false) {
          for (const stmt of gateStatements(command)) {
            if (MOVE_CMD.test(stmt) && TRASH.test(stmt)) {
              return deny("R1", "命令把文件**移动**到垃圾/回收站类目录。按 no-recycle-bin 裁定必须彻底删除"
                + "（删前仍须核验路径/清单/引用/占用进程）；确需保留请先取得用户明确指令。");
            }
          }
        }

        // ── R4 交接前置（本轮；读取证据绑定内容哈希）──────────────────────────────
        const need = Array.isArray(art.requireReads) ? art.requireReads : [];
        if (need.length) {
          const isRegisteredCmd = isShell && lp.actions.some((a) => a?.command === command);
          if (isWrite || isRegisteredCmd) {
            for (const r of need) {
              const p = abs(r);
              if (!existsSync(p)) continue;
              const key = readKey(p, await sha256File(p));
              if (!(reads instanceof Set) || !reads.has(key)) {
                return deny("R4", `本轮尚未**完整读取** ${r}（或读完之后文件已改变）。`
                  + `请先 read ${r}（不带 offset/limit），再原样重发这一条命令。只查哈希/只看存在均不算。`);
              }
            }
          }
        }

        // ── R5 参数闸 ───────────────────────────────────────────────────────────
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
                const captured = m.slice(1).find((x) => x !== undefined);
                vals.push(String(captured ?? m[0]));
                if (m.index === re.lastIndex) re.lastIndex += 1;
              }
            }
            const allowed = (Array.isArray(guard.allowed) ? guard.allowed : []).map(String);
            const label = guard.name ?? "参数";
            if (!vals.length) {
              if (guard.require === true) return deny("R5", `命令未显式给出${label}，而策略要求必须给出（允许：${allowed.join("/")}）。`);
              continue;
            }
            const bad = vals.filter((v) => !allowed.includes(v));
            if (bad.length || new Set(vals).size > 1) {
              return deny("R5", `${label}取值为「${vals.join(", ")}」，与当前有效裁定不符（允许值：${allowed.join(" / ")}）。`
                + "引号内出现的同名字符串不能作为证据；重复参数一律拒绝。");
            }
          }
        }

        // ── R2/R3/R6 write 侧 ───────────────────────────────────────────────────
        if (isWrite) {
          const args = exec?.arguments ?? {};
          const target = args.file_path ?? args.filePath ?? args.path;
          if (typeof target !== "string" || !target.trim()) return null;
          const p = abs(target);
          const rel = relOf(p);
          const content = String(args.content ?? args.text ?? "");
          const inside = !rel.startsWith("..");

          // R6 路径别名：UNC / 符号链接 / 硬链接 / 父目录 junction 一律拒绝（实际写入位置不可判定）
          if (/^\\\\|^\/\//.test(p)) {
            return deny("R6", `${rel} 是 UNC/网络路径，无法核对是否在授权集合内。请改写到项目内已登记的路径。`);
          }
          if (inside && existsSync(p)) {
            try {
              const st = lstatSync(p);
              if (st.isSymbolicLink()) return deny("R6", `${rel} 是符号链接，指向不可判定；先在策略里登记真实目标或改写普通文件。`);
              if (st.nlink > 1) return deny("R6", `${rel} 是硬链接（nlink=${st.nlink}），写入会波及授权集合之外的同一文件。`);
            } catch { /* lstat 失败不拦 */ }
          }
          if (inside) {
            const parts = rel.split("/");
            let cur = cwd;
            for (let i = 0; i < parts.length - 1; i += 1) {
              cur = resolve(cur, parts[i]);
              try {
                if (lstatSync(cur).isSymbolicLink()) {
                  return deny("R6", `路径中 ${parts.slice(0, i + 1).join("/")} 是符号链接/junction，实际写入位置不可判定。`);
                }
              } catch { /* 不存在或不可读的中间层不拦 */ }
            }
          }

          // R2 产物登记
          if (inside && !existsSync(p) && art.registerNew !== false && !registered(rel)) {
            return deny("R2", `项目内新文件 ${rel} 未在策略里登记（artifact.allowNew / artifact.scratch），`
              + "也不是任何已登记动作的产物。先在项目策略登记该产物路径，或在 scratch 目录里写。");
          }

          // R3 文体声明（策略可按路径指定允许的文体集合）
          const specs = Array.isArray(art.specs) ? art.specs : [];
          const genrePaths = (Array.isArray(art.genrePaths) ? art.genrePaths : []).map(globToRe);
          let allowedGenres = null;
          for (const spec of specs) {
            const pats = (Array.isArray(spec?.paths) ? spec.paths : []).map(globToRe);
            if (pats.some((re) => re.test(rel))) {
              allowedGenres = new Set((Array.isArray(spec.genre) && spec.genre.length ? spec.genre : [...GENRES]).map((g) => String(g).toLowerCase()));
              break;
            }
          }
          if (!allowedGenres && genrePaths.some((re) => re.test(rel))) allowedGenres = GENRES;
          if (allowedGenres) {
            const m = GENRE_RE.exec(content.slice(0, 2000));
            const genre = m ? m[1].toLowerCase() : "";
            if (!m || !allowedGenres.has(genre)) {
              return deny("R3", `目标 ${rel} 需要在正文开头声明文体，且必须是允许值之一。`
                + `请写一行 \`genre: <值>\`（允许：${[...allowedGenres].join(" / ")}），再写入。`);
            }
          }
        }

        // ── R7 shell 写入登记（绕过 write 工具直接写文件）─────────────────────────
        if (isShell && art.registerNew !== false) {
          const candidates = new Set();
          for (const s of gateStatements(command)) {
            if (!SHELL_WRITE.test(s)) continue;
            let m;
            FILE_ARG.lastIndex = 0;
            while ((m = FILE_ARG.exec(s)) !== null) candidates.add(unquote(m[1]));
            REDIRECT_TARGET.lastIndex = 0;
            while ((m = REDIRECT_TARGET.exec(s)) !== null) candidates.add(unquote(m[1]));
          }
          for (const raw of candidates) {
            if (!raw || /^(?:\/dev\/null|NUL|\$|%)/i.test(raw)) continue;
            const p = abs(raw);
            const rel = relOf(p);
            if (rel.startsWith("..")) continue;              // 项目外不判
            if (registered(rel)) continue;
            if (lp.actions.some((a) => (a?.files ?? []).some((f) => f?.role === "output" && resolve(f.path) === p))) continue;
            return deny("R7", `命令要向项目内未登记的路径写文件：${rel}。`
              + "请在策略 artifact.allowNew 里登记该产物，或改写到 scratch 目录；"
              + "（脚本内部的写入本闸看不见，这条只覆盖命令行直接写入。）");
          }
        }
        return null;
      } catch {
        return null; // 闸自身出错绝不拦主流程（与其余闸门同一兜底策略）
      }
    },
  };
}
