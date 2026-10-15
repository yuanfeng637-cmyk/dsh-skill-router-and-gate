import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
