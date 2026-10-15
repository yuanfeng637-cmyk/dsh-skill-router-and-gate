import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { buildResourceIndex, routeResources, rankResourceCandidates, renderResources, skillDeclaration } from "../lib/resourceindex.js";
import { createArtifactGuard } from "../lib/artifactguard.js";
import { fixture } from "./resource-fixture.mjs";

const cases = [
  ["给这张图写图注", ["figure-legend-gen", "figure-legend-writer"]],
  ["写材料方法", ["scientific-writing"]],
  ["make an xlsx table of counts", ["office-xlsx"]],
  ["系统发育树怎么画", ["phylogenetic-tree-styler", "bioinformatics-toolkit"]],
  ["做一次重组检测", ["rdp4-recomb-mosaic"]],
];

test("82-entry real lexical corpus: all five requests route with prerequisites in name-only and full catalog modes", async () => {
  const corpus = JSON.parse(await readFile(new URL("./routing-corpus.json", import.meta.url), "utf8"));
  assert.equal(corpus.skills.length, 82);
  const dir = await mkdtemp(join(tmpdir(), "routing-corpus-"));
  const catalog = [];
  for (const s of corpus.skills) {
    const root = join(dir, s.name);
    await mkdir(root, { recursive: true });
    if (s.readable) {
      // Preserve field token sets, not private prose or executable source files.
      const text = `---\nname: ${s.name}\ndescription: >\n  ${s.description.replaceAll("\n", "\n  ")}\n---\n# ${s.headings.join(" ")}\n${s.body.join(" ")}`;
      await writeFile(join(root, "SKILL.md"), text);
    }
    for (const r of s.resources) {
      const path = join(root, r.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `# ${r.label.join(" ")}\n${r.content.join(" ")}`);
    }
    catalog.push({ name: s.name, description: s.description, path: join(root, "SKILL.md") });
  }
  for (const entries of [catalog.map(s => ({ name: s.name })), catalog]) {
    const idx = await buildResourceIndex(entries, { roots: [dir] });
    assert.equal(idx.reduce((n, s) => n + s.resources.length, 0), 172);
    for (const [q, expected] of cases) {
      const picks = routeResources(q, idx);
      assert.ok(expected.includes(picks[0]?.name), `${q}: ${picks.map(p => p.name)}`);
      assert.ok(picks.every(p => p.resources.some(r => r.required)), "no empty prerequisite gate");
      assert.deepEqual(routeResources(q, [...idx].reverse()), picks);
      const ranked = rankResourceCandidates(q, idx);
      assert.ok(ranked[0].score - ranked[1].score >= 0.02);
    }
    // A missing catalog entry is not permission to invent an installed candidate.
    const omitted = idx.filter(s => s.name !== "office-xlsx");
    assert.deepEqual(routeResources(cases[2][0], omitted), []);
  }
});

test("original figure legend / DOCX / XLSX fixtures also support name-only discovery", async () => {
  const { dir, skills } = await fixture();
  for (const entries of [skills, skills.map(s => ({ name: s.name }))]) {
    const idx = await buildResourceIndex(entries, { roots: [dir] });
    for (const [q, expected] of [["给这张图写图注", "figure-legend-studio"], ["figure legend", "figure-legend-studio"], ["做 docx 报告", "office-docx"], ["做 xlsx 表", "office-xlsx"]]) {
      assert.equal(routeResources(q, idx)[0]?.name, expected);
      assert.ok(routeResources(q, idx)[0].resources.some(r => r.required));
    }
  }
});

test("generic ambiguity abstains; field length, boilerplate and identifiers cannot force a route", async () => {
  const entries = ["aurora", "borealis"].map(name => ({ name, content: "# Calibration", description: "quasar telemetry calibration" }));
  assert.deepEqual(routeResources("quasar telemetry", await buildResourceIndex(entries, { roots: [] })), []);
  const idx = await buildResourceIndex([
    { name: "neutral", description: "quasar telemetry", content: "# Telemetry" },
    { name: "distractor", description: "tools analysis workflow", content: "# General\n" + "quasar telemetry and generic words ".repeat(800) },
  ], { roots: [] });
  assert.equal(routeResources("quasar telemetry", idx)[0]?.name, "neutral");
  assert.deepEqual(routeResources("unseenword zzyy", idx), []);
  assert.match(renderResources(routeResources("quasar telemetry", idx)).join("\n"), /该技能无可前置阅读的资源/);
});

test("SKILL.md fallback really gates writes, aliases, shell and registered outputs; full read hash unlocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fallback-prerequisite-"));
  const root = join(dir, "arbitrary-name");
  await mkdir(root);
  const path = join(root, "SKILL.md"), body = "---\ndescription: quasar telemetry\n---\n# Quasar telemetry";
  await writeFile(path, body);
  const routes = routeResources("quasar telemetry", await buildResourceIndex([{ name: "arbitrary-name", path }], { roots: [] }));
  assert.equal(routes[0].resources[0].path, path);
  assert.equal(routes[0].resources[0].prerequisite, true);
  assert.match(renderResources(routes).join("\n"), /READ FIRST.*SKILL.md fallback/);
  const policy = join(dir, "policy.json");
  await writeFile(policy, JSON.stringify({ artifact: { registerNew: false }, actions: [{ command: "emit", files: [{ role: "output", path: join(dir, "opaque.bin") }] }] }));
  const guard = createArtifactGuard({ policyPath: policy });
  const ctx = { routes, reads: new Set() }, agent = { session: { header: { cwd: dir } } };
  const actions = ["write", "create_file", "edit"].map(name => ({ name, agent, arguments: { file_path: "opaque.bin", content: "output" } }));
  actions.push({ name: "pwsh", agent, arguments: { command: "Set-Content -Path opaque.bin -Value output" } }, { name: "pwsh", agent, arguments: { command: "emit" } });
  for (const a of actions) assert.match((await guard.pre(a, "s", ctx))?.reason ?? "", /R4/);
  ctx.reads.add(path);
  assert.match((await guard.pre(actions[0], "s", ctx))?.reason ?? "", /R4/);
  ctx.reads.add(`${path}#${createHash("sha256").update(body).digest("hex")}`);
  for (const a of actions) assert.equal(await guard.pre(a, "s", ctx), null);
  await writeFile(path, body + "\nchanged");
  for (const a of actions) assert.match((await guard.pre(a, "s", ctx))?.reason ?? "", /R4/);
});

test("catalog declaration reads quoted, plain, folded and literal text without evaluating YAML", () => {
  for (const declaration of ['description: "quasar telemetry"', "description: 'quasar telemetry'", "description: quasar telemetry", "description: >\n  quasar\n  telemetry", "description: |\n  quasar\n  telemetry"]) {
    assert.equal(skillDeclaration(`---\n${declaration}\n---\n# Body`).description, "quasar telemetry");
  }
});
