/** Local, deterministic routing. No task/format -> skill/reference lookup table. */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const RESOURCE_DEFAULTS = Object.freeze({ enabled: true, minScore: 0.28,
  resourceMinScore: 0.22, artifactMinScore: 0.45, minMargin: 0.02, topN: 3 });
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stop = new Set("a an the to of for and or in on with this that use when is are be file files write create make report how do can help me my 做 请 给 这 那 这些 那些 个 张 份 本 我 你 它 将 把 为 对 写 一个 一次 怎么 画 报告".split(" "));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase();
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
// Lexical equivalences only: no skill identifiers, paths, task predicates or
// preferred destinations. Applied symmetrically to queries and every field.
const vocabulary = [
  ["authoring", "write", "writing", "writes", "create", "creating", "generate", "generating", "make", "draft", "撰写", "写作", "编写", "生成", "制作", "写"],
  ["reading", "read", "reads", "reading", "读取", "阅读"],
  ["legend", "图注", "图例"], ["material method", "材料方法", "材料与方法"], ["method", "方法"],
  ["figure", "图片", "图像"], ["table", "表格"], ["document", "文档"],
  ["phylogenetic", "系统发育"], ["tree", "树"], ["recombination", "重组"],
  ["detection", "检测"], ["sequence", "序列"], ["alignment", "比对"],
  ["genome", "基因组"], ["gene", "基因"], ["protein", "蛋白质"],
  ["abstract", "摘要"], ["introduction", "引言"], ["result", "结果"],
  ["discussion", "讨论"], ["citation", "引文"], ["reference", "参考文献"],
  ["manuscript", "论文"], ["statistic", "统计"], ["sample", "样本"],
  ["data", "数据"], ["analysis", "分析"], ["visualization", "可视化"],
  ["format", "格式"], ["formula", "公式"], ["image", "影像"],
  ["database", "数据库"], ["search", "检索"], ["memory", "记忆"],
  ["test", "测试"], ["code", "代码"], ["project", "项目"],
  ["review", "审阅"], ["revision", "修订"], ["translation", "翻译"],
  ["presentation", "演示文稿"], ["spreadsheet", "电子表格"],
];
const aliases = vocabulary.flatMap(([word, ...aliases]) => aliases.map((alias) => [alias, word]))
  .sort((a, b) => b[0].length - a[0].length || order(a[0], b[0]));
const stem = (t) => t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
export function terms(text) {
  let s = norm(text);
  for (const [alias, word] of aliases) s = /[a-z]/.test(alias)
    ? s.replace(new RegExp(`\\b${alias}\\b`, "g"), ` ${word} `) : s.replaceAll(alias, ` ${word} `);
  const out = new Set((s.match(/[a-z][a-z0-9]+/g) ?? []).filter((t) => !stop.has(t)).map(stem));
  // Remove general function words before bigrams. Keep adjacent single-character
  // noun segments: Intl may split an unfamiliar noun into individual characters.
  for (const run of s.match(/[\u3400-\u9fff]+/gu) ?? []) {
    for (const { segment } of segmenter.segment(run)) {
      if (stop.has(segment)) continue;
      for (let i = 0; i + 1 < segment.length; i++) out.add(segment.slice(i, i + 2));
    }
  }
  return out;
}
export function overlap(query, text) {
  const q = terms(query), t = terms(text);
  const hits = [...q].filter((x) => t.has(x)).sort(order);
  return { score: q.size ? hits.length / q.size : 0, hits };
}
const headings = (s) => (s.match(/^\s*#{1,6}\s+.+$/gm) ?? []).join("\n");

/** The subset of YAML used for catalog text (plain, quoted, folded/literal).
 * Never evaluate YAML tags or import executable metadata. */
export function skillDeclaration(body) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? "";
  const fields = {};
  const re = /^(name|description|whenToUse):[ \t]*(.*)((?:\r?\n[ \t]+[^\n]*)*)/gm;
  for (const m of block.matchAll(re)) {
    let value = m[2].trim();
    if (/^[>|][-+]?$/.test(value)) value = m[3].trim().replace(/\s+/g, " ");
    else if (/^["']/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[m[1]] = value;
  }
  return fields;
}

async function textFile(path) {
  try {
    if ((await stat(path)).size > 1024 * 1024) return "";
    const bytes = await readFile(path);
    return bytes.includes(0) ? "" : bytes.toString("utf8");
  } catch { return ""; }
}
async function resources(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => order(a.name, b.name))) {
      // Do not follow links outside a skill's directory or into recursion cycles.
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const content = await textFile(path);
        out.push({ path, label: `${e.name}\n${headings(content)}`, content,
          reference: path.slice(root.length + 1).replaceAll("\\", "/").startsWith("references/") });
      }
    }
  }
  for (const folder of ["references", "scripts", "assets"]) await walk(join(root, folder));
  return out;
}

/** Snapshot remains the authority for installation/scope/invocation eligibility.
 * Read every eligible entry, including already loaded skills; refresh on each turn,
 * so changed SKILL.md/reference contents cannot leave a stale routing cache. */
export async function installedProviderRoots() {
  const roots = [];
  // Resolve only names already admitted by the snapshot, never add candidates.
  // pnpm's provider package convention is discovery metadata, not a task map.
  const store = join(homedir(), ".dsh", "app", "node_modules", ".pnpm");
  let entries;
  try { entries = await readdir(store, { withFileTypes: true }); } catch { return roots; }
  for (const entry of entries.filter(e => e.isDirectory() && e.name.startsWith("@deepseek-ai+dsh-skill-")).sort((a,b) => order(a.name,b.name))) {
    const scope = join(store, entry.name, "node_modules", "@deepseek-ai");
    let packages;
    try { packages = await readdir(scope, { withFileTypes: true }); } catch { continue; }
    for (const p of packages.filter(p => p.name.startsWith("dsh-skill-")).sort((a,b) => order(a.name,b.name))) {
      roots.push(join(scope, p.name, "assets"));
    }
  }
  return roots;
}

export async function buildResourceIndex(skills, { roots } = {}) {
  roots ??= [join(homedir(), ".dsh", "skills"), join(homedir(), ".agents", "skills"),
    join(homedir(), ".codex", "skills"), ...await installedProviderRoots()];
  const rows = [];
  for (const skill of [...skills].sort((a, b) => order(a.name, b.name))) {
    try {
      const explicit = [skill.path, skill.resourceBase?.kind === "directory" ? skill.resourceBase.path : null,
        skill.filePath, skill.location, skill.directory, skill.root].filter((v) => typeof v === "string");
      // Never substitute a same-named global skill for an inaccessible scoped one.
      const candidates = explicit.length ? explicit : roots.map((r) => join(r, skill.name));
      let root = null, body = typeof skill.content === "string" ? skill.content : "";
      for (const candidate of candidates) {
        const dir = /SKILL\.md$/i.test(candidate) ? dirname(candidate) : candidate;
        const text = await textFile(join(dir, "SKILL.md"));
        if (text) { root = resolve(dir); body = text; break; }
      }
      if (skill.resourceBase?.kind === "directory") root = resolve(skill.resourceBase.path);
      const children = root ? await resources(root) : [];
      const declared = skillDeclaration(body);
      rows.push({ name: skill.name, root, resources: children,
        skillPath: root && body ? join(root, "SKILL.md") : null,
        description: [skill.description ?? declared.description, skill.whenToUse ?? declared.whenToUse].filter(Boolean).join("\n"),
        headings: headings(body),
        label: [skill.name, root ? basename(root) : "", skill.description, skill.whenToUse,
          JSON.stringify(skill.metadata ?? {}), headings(body)].join("\n"), body });
    } catch { /* One unreadable skill must not prevent other skills from routing. */ }
  }
  return rows;
}

/** IDF-weighted coverage with logarithmic field-length normalization.
 * df is per skill (not per child), so a skill cannot gain votes by adding files. */
export function rankResourceCandidates(query, index, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options };
  if (!cfg.enabled) return [];
  const q = terms(query);
  const df = new Map();
  for (const s of index) {
    for (const t of terms(`${s.name}\n${s.description}\n${s.body}\n${s.resources.map(r => r.label + '\n' + r.content).join('\n')}`)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = t => Math.log(1 + (index.length + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const denominator = [...q].reduce((sum, t) => sum + idf(t), 0);
  const match = text => {
    const ts = terms(text), hits = [...q].filter(t => ts.has(t)).sort(order);
    const coverage = denominator ? hits.reduce((sum, t) => sum + idf(t), 0) / denominator : 0;
    return { score: coverage / (1 + 0.12 * Math.log1p(ts.size / Math.max(1, q.size))), hits };
  };
  const ranked = index.map(s => {
    const children = s.resources.map(r => {
      const title = match(r.label), body = match(r.content);
      const chosen = title.score >= body.score * 0.7 ? title : { ...body, score: body.score * 0.7 };
      return { ...r, ...chosen, basis: chosen === title ? 'filename/title' : 'content',
        required: r.reference && chosen.score >= cfg.resourceMinScore };
    });
    const fields = { name: match(s.name.replaceAll(/[-_]/g, ' ')),
      description: match(s.description), headings: match(s.headings), body: match(s.body) };
    const best = children.reduce((a, r) => r.score > a.score ? r : a, { score: 0, hits: [] });
    const parts = { name: 0.9 * fields.name.score, description: fields.description.score,
      headings: 0.75 * fields.headings.score, body: 0.45 * fields.body.score, resource: 0.55 * best.score };
    const declaration = terms(`${s.name}\n${s.description}`);
    const actionCompatibility = q.has("authoring") && declaration.has("reading") && !declaration.has("authoring") ? 0.5 : 1;
    const score = actionCompatibility * (Math.max(...Object.values(parts)) + 0.25 * parts.description + 0.75 * parts.name + 0.50 * parts.resource + 0.15 * parts.body) / 2.275;
    const hits = [...new Set([...Object.values(fields).flatMap(f => f.hits), ...best.hits])].sort(order);
    return { name: s.name, score, parts, why: `local IDF index score=${score.toFixed(3)}; hits=${hits.join(',')}`,
      resources: children, skillPath: s.skillPath, body: s.body };
  }).sort((a, b) => b.score - a.score || order(a.name, b.name));
  return ranked;
}

export function routeResources(query, index, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options };
  const ranked = rankResourceCandidates(query, index, cfg);
  // Ambiguity is an explicit abstention, never an alphabetical best guess.
  if (!ranked.length || ranked[0].score < cfg.minScore
    || (ranked.length > 1 && ranked[0].score - ranked[1].score < cfg.minMargin)) return [];
  return ranked.filter(p => p.score >= cfg.minScore && ranked[0].score - p.score <= cfg.minMargin)
    .slice(0, cfg.topN).map(p => withPrerequisite(p));
}

/** Every selected skill with a readable entry point has an executable read.
 * Existing matching references retain their artifact-specific association. */
export function withPrerequisite(p) {
  if (p.resources.some(r => r.required)) return p;
  if (!p.skillPath) return { ...p, prerequisiteStatus: '该技能无可前置阅读的资源' };
  return { ...p, prerequisiteStatus: 'SKILL.md fallback', resources: [...p.resources, {
    path: p.skillPath, label: p.name, content: p.body, reference: true,
    required: true, prerequisite: true, score: p.score ?? 0, hits: [], basis: 'SKILL.md fallback',
  }] };
}
export function renderResources(picks) {
  return picks.flatMap((p) => [...(p.prerequisiteStatus === "该技能无可前置阅读的资源"
    ? [`Resource for ${p.name}: 该技能无可前置阅读的资源`] : []), ...(p.resources ?? []).map((r) =>
    `Resource for ${p.name}: ${r.path} | ${r.required ? "READ FIRST" : "available"}; score=${r.score.toFixed(3)}; basis=${r.basis ?? "not selected"}; matched=${r.hits.join(",") || "none"}`)]);
}

/** Content-derived output association, restricted to skills selected by routing.
 * Basename/headings measure lexical overlap; extension matching is inferred from
 * the reference's own text, never from a hardcoded list of document formats. */
export function referenceMatchesArtifact(resource, target, content = "", options = {}) {
  if (!resource.reference) return false;
  if (resource.prerequisite) return true;
  const ext = extname(target).slice(1).toLowerCase();
  const source = `${resource.label}\n${resource.content}`;
  if (ext && terms(resource.content).has(ext)) return true;
  const signature = `${basename(target, extname(target))}\n${headings(content)}`;
  return overlap(signature, source).score >= (options.artifactMinScore ?? RESOURCE_DEFAULTS.artifactMinScore);
}
