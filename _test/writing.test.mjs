import { test } from "node:test";
import assert from "node:assert/strict";
import { writingPicks, skillReferences } from "../lib/judge.js";

test("deterministic writing intent covers Chinese/English and only installed scientific-writing", () => {
  const skills = [{ name: "scientific-writing" }];
  for (const query of ["写材料方法", "写论文", "请撰写材料与方法", "润色论文", "修改摘要", "Write the Methods section", "Draft a scientific paper", "revise this manuscript"]) {
    assert.deepEqual(writingPicks(query, skills).map((p) => p.name), ["scientific-writing"], query);
    assert.deepEqual(writingPicks(query, []), [], query);
  }
  for (const query of ["写代码", "今天天气", "论文是什么", "查看材料方法文件", "启动建树", "write a sorting function"]) {
    assert.deepEqual(writingPicks(query, skills), [], query);
  }
  assert.deepEqual(skillReferences("scientific-writing"), ["references/imrad_structure.md"]);
  assert.deepEqual(skillReferences("unknown"), []);
});
