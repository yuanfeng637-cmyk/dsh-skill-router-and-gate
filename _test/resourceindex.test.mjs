import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildResourceIndex, routeResources, renderResources, referenceMatchesArtifact } from "../lib/resourceindex.js";
import { createArtifactGuard } from "../lib/artifactguard.js";

export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "generic-routing-"));
  const defs = [
    ["figure-legend-studio", "Figure legend 图注", "# Figure legend 图注\nGuidance for figure legends and 图注."],
    ["office-docx", "Office docx", "# DOCX report\nCreate .docx documents and reports."],
    ["office-xlsx", "Office xlsx", "# XLSX tables\nCreate .xlsx spreadsheets and tables."],
  ];
  const skills = [];
  for (const [name, title, body] of defs) {
    const root = join(dir, name);
    for (const child of ["references/nested", "scripts", "assets"]) await mkdir(join(root, child), { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\n---\n# ${title}\n## When to use\n${title}`);
    await writeFile(join(root, "references/nested/guide.md"), body);
    await writeFile(join(root, "scripts/helper.js"), "// local helper");
    await writeFile(join(root, "assets/template.txt"), "template");
    skills.push({ name, path: join(root, "SKILL.md"), description: title });
  }
  return { dir, skills };
}

test("generic index: figure legends and office DOCX/XLSX route independently of writing rule, with child paths/evidence", async () => {
  const { skills } = await fixture();
  const index = await buildResourceIndex(skills, { roots: [] });
  for (const [q, name] of [["给这张图写图注", "figure-legend-studio"], ["给这张图写图注 / figure legend", "figure-legend-studio"], ["做 docx 报告", "office-docx"], ["做 xlsx 表", "office-xlsx"]]) {
    const picks = routeResources(q, index);
    assert.equal(picks[0].name, name);
    assert.ok(picks[0].resources.some((r) => r.required && r.hits.length));
    const text = renderResources(picks).join("\n");
    assert.match(text, /references.*nested.*guide.md.*READ FIRST/);
    assert.match(text, /scripts.*helper.js/);
    assert.match(text, /assets.*template.txt/);
    assert.deepEqual(routeResources(q, [...index].reverse()), picks, "catalog enumeration cannot affect ranking");
    assert.deepEqual(routeResources(q, index, { minScore: 1.1 }), []);
    assert.deepEqual(routeResources(q, index, { enabled: false }), []);
  }
});

test("generic R4: route-derived refs gate write/edit/create, direct shell and registered outputs; hashes invalidate", async () => {
  const { dir, skills } = await fixture();
  const index = await buildResourceIndex(skills, { roots: [] });
  for (const [q, target] of [["figure legend", "figure_legend.md"], ["做 docx 报告", "report.docx"], ["做 xlsx 表", "table.xlsx"]]) {
    const routes = routeResources(q, index);
    const ref = routes[0].resources.find((r) => r.required);
    const policy = join(dir, "policy.json");
    const command = "generate-current-artifact";
    await writeFile(policy, JSON.stringify({ version: 1, artifact: { registerNew: false,
      resourceRouting: { enabled: true, artifactMinScore: 0.45 } }, actions: [
      { command, files: [{ role: "output", path: join(dir, target) }] }] }));
    const guard = createArtifactGuard({ policyPath: policy });
    const ctx = { routes, loaded: new Set(routes.map((r) => r.name)), reads: new Set() };
    const agent = { session: { header: { cwd: dir } } };
    const writes = ["write", "edit", "create_file"].map((name) => ({ name, agent, arguments: { file_path: target, content: "output" } }));
    writes.push({ name: "pwsh", agent, arguments: { command: `Set-Content -Path ${target} -Value output` } },
      { name: "pwsh", agent, arguments: { command } });
    for (const exec of writes) assert.match((await guard.pre(exec, "s", ctx))?.reason ?? "", /R4/);
    ctx.reads.add(ref.path); // A claimed path is not complete-read evidence.
    assert.match((await guard.pre(writes[0], "s", ctx))?.reason ?? "", /R4/);
    const hash = createHash("sha256").update(ref.content).digest("hex");
    ctx.reads.add(`${ref.path}#${hash}`);
    for (const exec of writes) assert.equal(await guard.pre(exec, "s", ctx), null);
    await writeFile(ref.path, ref.content + "\nupdated");
    for (const exec of writes) assert.match((await guard.pre(exec, "s", ctx))?.reason ?? "", /R4/);
    assert.equal(await guard.pre({ ...writes[0], arguments: { file_path: "unrelated.zzyy" } }, "s", ctx), null);
    assert.equal(referenceMatchesArtifact(ref, target, "", { artifactMinScore: 2 }), target.endsWith(".md") ? false : true);
  }
});

test("index refresh uses changed content; missing roots and unreadable files fail open", async () => {
  const { skills } = await fixture();
  const index = await buildResourceIndex(skills, { roots: [] });
  const path = index[0].resources.find((r) => r.reference).path;
  await writeFile(path, "# Quasar telemetry\nquasar telemetry calibration");
  const refreshed = await buildResourceIndex(skills, { roots: [] });
  assert.equal(routeResources("quasar telemetry", refreshed)[0].name, index[0].name);
  assert.deepEqual((await buildResourceIndex([{ name: "missing-skill" }], { roots: [] }))[0].resources, []);
});

test("content features infer Methods outputs for an arbitrary skill/reference name, without a policy path table", async () => {
  const { dir } = await fixture();
  await mkdir(join(dir, "custom", "references"), { recursive: true });
  await writeFile(join(dir, "custom", "SKILL.md"), "# Aurora\nUse for study documentation");
  await writeFile(join(dir, "custom", "references", "opaque.md"), "## Methods\nStudy design and samples");
  const index = await buildResourceIndex([{ name: "aurora", resourceBase: { kind: "directory", path: join(dir, "custom") } }], { roots: [] });
  const selected = routeResources("Methods", index)[0];
  assert.equal(selected.name, "aurora");
  const ref = selected.resources[0];
  assert.equal(ref.required, true);
  assert.equal(referenceMatchesArtifact(ref, "METHODS.md"), true);
  assert.equal(referenceMatchesArtifact(ref, "notes.md", "## Methods"), true);
  assert.equal(referenceMatchesArtifact(ref, "BUDGET.md"), false);
});

test("scoped paths never fall back to a same-named home skill; route state is bounded and independent of R8", async () => {
  const { dir, skills } = await fixture();
  const index = await buildResourceIndex([{ ...skills[0], path: join(dir, "absent", "SKILL.md") }], { roots: [dir] });
  assert.deepEqual(index[0].resources, []);
  const { createSessionState } = await import("../lib/sessionstate.js");
  const state = createSessionState({ maxSessions: 2 });
  state.setRoutes("a", ["ref-a"]);
  state.setPicks("a", ["skill-a"]);
  state.clearPicks("a");
  assert.deepEqual(state.routesOf("a"), ["ref-a"]);
  state.setRoutes("b", []); state.setRoutes("c", []);
  assert.deepEqual(state.routesOf("a"), []);
  state.setRoutes("d", ["ref-d"]); state.drop("d");
  assert.deepEqual(state.routesOf("d"), []);
});
