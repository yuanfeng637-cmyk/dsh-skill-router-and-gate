/** Offline local smoke run; never changes installed skills, policy or processes. */
import { readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { buildResourceIndex, installedProviderRoots, routeResources, terms } from "../lib/resourceindex.js";
const root = join(homedir(), ".dsh", "skills");
const skills = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => ({ name: d.name }));
const original = await buildResourceIndex(skills);
const names = new Set(skills.map(s => s.name));
for (const base of await installedProviderRoots()) {
  let dirs;
  try { dirs = await readdir(base, { withFileTypes: true }); } catch { continue; }
  for (const d of dirs.filter(d => d.isDirectory())) {
    if (names.has(d.name)) continue;
    const entry = { name: d.name, path: join(base, d.name, "SKILL.md") };
    if ((await buildResourceIndex([entry]))[0]?.skillPath) { names.add(d.name); skills.push(entry); }
  }
}
const full = await buildResourceIndex(skills);
if (process.argv.includes("--capture")) {
  const corpus = full.map(s => ({ name: s.name, description: s.description, readable: !!s.skillPath,
    headings: [...terms(s.headings)].sort(), body: [...terms(s.body)].sort(),
    sha256: createHash("sha256").update(s.body).digest("hex"),
    resources: s.resources.map(r => ({ path: relative(s.root, r.path).replaceAll("\\", "/"),
      label: [...terms(r.label)].sort(), content: [...terms(r.content)].sort(), reference: r.reference })) }));
  await writeFile(new URL("./routing-corpus.json", import.meta.url), '{\n"source":' + JSON.stringify("2026-10-15 local 79 directory entries + installed bundled providers; deduplicated lexical features, no source prose") + ',\n"skills":[\n' + corpus.map(s => JSON.stringify(s)).join(',\n') + '\n]}\n');
}
for (const [mode, index] of [
  ["original79", original],
  ["name-only", await buildResourceIndex(skills.map(s => ({ name: s.name })))],
  ["full-catalog", await buildResourceIndex(full.map(s => ({ name: s.name, description: s.description,
    path: s.skillPath ?? join(root, s.name, "SKILL.md") })))],
]) {
  console.log(`MODE=${mode} 技能数=${index.length} 子资源=${index.reduce((n, s) => n + s.resources.length, 0)}`);
  for (const q of ["给这张图写图注", "写材料方法", "make an xlsx table of counts", "系统发育树怎么画", "做一次重组检测"]) {
    const picks = routeResources(q, index, { topN: 3 });
    console.log(q + " => " + (picks.map(p => p.name + ":" + p.score.toFixed(2) + "[" + p.resources.filter(r => r.required).length + "]").join("  ") || "无路由"));
  }
}
