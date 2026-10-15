/** Local, deterministic routing. No task/format -> skill/reference lookup table. */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const RESOURCE_DEFAULTS = Object.freeze({ enabled: true, minScore: 0.28,
  resourceMinScore: 0.22, artifactMinScore: 0.45, topN: 3 });
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stop = new Set("a an the to of for and or in on with this that use when is are be file files write create make report 做 请 给 这 那 这些 那些 个 张 份 本 我 你 它 将 把 为 对 写 一个 报告".split(" "));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase();
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function terms(text) {
  const s = norm(text);
  const out = new Set((s.match(/[a-z][a-z0-9]+/g) ?? []).filter((t) => !stop.has(t)));
  // Remove general function words before bigrams. Keep adjacent single-character
  // noun segments: Intl may split an unfamiliar noun into individual characters.
  for (const run of s.match(/[\u3400-\u9fff]+/gu) ?? []) {
    const filtered = [...segmenter.segment(run)].map((x) => x.segment).filter((x) => !stop.has(x)).join("");
    for (let i = 0; i + 1 < filtered.length; i++) out.add(filtered.slice(i, i + 2));
  }
  return out;
}
export function overlap(query, text) {
  const q = terms(query), t = terms(text);
  const hits = [...q].filter((x) => t.has(x)).sort(order);
  return { score: q.size ? hits.length / q.size : 0, hits };
}
const headings = (s) => (s.match(/^\s*#{1,6}\s+.+$/gm) ?? []).join("\n");

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
export async function buildResourceIndex(skills, { roots = [join(homedir(), ".dsh", "skills"),
  join(homedir(), ".agents", "skills"), join(homedir(), ".codex", "skills")] } = {}) {
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
      rows.push({ name: skill.name, root, resources: children,
        label: [skill.name, root ? basename(root) : "", skill.description, skill.whenToUse,
          JSON.stringify(skill.metadata ?? {}), headings(body)].join("\n"), body });
    } catch { /* One unreadable skill must not prevent other skills from routing. */ }
  }
  return rows;
}

export function routeResources(query, index, options = {}) {
  const cfg = { ...RESOURCE_DEFAULTS, ...options };
  if (!cfg.enabled) return [];
  return index.map((s) => {
    const children = s.resources.map((r) => {
      const title = overlap(query, r.label), body = overlap(query, r.content);
      const match = title.score >= body.score * 0.7 ? title : { ...body, score: body.score * 0.7 };
      return { ...r, score: match.score, hits: match.hits, basis: match === title ? "filename/title" : "content",
        required: r.reference && match.score >= cfg.resourceMinScore };
    });
    const label = overlap(query, s.label), body = overlap(query, s.body);
    const best = children.reduce((a, r) => r.score > a.score ? r : a, { score: 0, hits: [] });
    const name = overlap(query, s.name.replaceAll(/[-_]/g, " "));
    // Exact directory/name evidence outranks incidental mentions in a long body.
    const score = Math.max(name.score, label.score * 0.85, body.score * 0.65, best.score * 0.9);
    const hits = [...new Set([...label.hits, ...body.hits, ...best.hits])].sort(order);
    return { name: s.name, score, why: `local index score=${score.toFixed(3)}; hits=${hits.join(",")}`,
      resources: children };
  }).filter((p) => p.score >= cfg.minScore)
    .sort((a, b) => b.score - a.score || order(a.name, b.name)).slice(0, cfg.topN);
}

export function renderResources(picks) {
  return picks.flatMap((p) => (p.resources ?? []).map((r) =>
    `Resource for ${p.name}: ${r.path} | ${r.required ? "READ FIRST" : "available"}; score=${r.score.toFixed(3)}; basis=${r.basis ?? "not selected"}; matched=${r.hits.join(",") || "none"}`));
}

/** Content-derived output association, restricted to skills selected by routing.
 * Basename/headings measure lexical overlap; extension matching is inferred from
 * the reference's own text, never from a hardcoded list of document formats. */
export function referenceMatchesArtifact(resource, target, content = "", options = {}) {
  if (!resource.reference) return false;
  const ext = extname(target).slice(1).toLowerCase();
  const source = `${resource.label}\n${resource.content}`;
  if (ext && terms(resource.content).has(ext)) return true;
  const signature = `${basename(target, extname(target))}\n${headings(content)}`;
  return overlap(signature, source).score >= (options.artifactMinScore ?? RESOURCE_DEFAULTS.artifactMinScore);
}
