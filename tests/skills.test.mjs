import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import {
  importSkill,
  inspectZipDirectory,
  mergeCatalog,
  packagePath,
  parseCatalog,
  parseMetadata,
  rawUrl,
  sha256,
  toRecord,
  DEFAULT_SOURCE,
} from "../.test-build/skill-utils.js";
import { publishSkill } from "../.test-build/skill-github.js";

const skillText = `---
name: sample-skill
description: A sample team workflow.
metadata:
  version: "1.2.3"
---

# Sample
`;

const packageFile = async (extra = {}) => {
  const zip = new JSZip();
  zip.file("sample-skill/SKILL.md", skillText);
  zip.file("sample-skill/README.md", "# Sample Skill\n");
  Object.entries(extra).forEach(([name, content]) => zip.file(name, content));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return new File([blob], "sample-skill.zip", { type: "application/zip" });
};

test("metadata and catalog validation preserve stable package paths", () => {
  assert.deepEqual(parseMetadata(skillText), {
    name: "sample-skill",
    description: "A sample team workflow.",
    version: "1.2.3",
  });
  assert.equal(packagePath("sample-skill", "1.2.3"), "public/skills/packages/sample-skill/1.2.3.zip");
  assert.equal(rawUrl(DEFAULT_SOURCE, packagePath("sample-skill", "1.2.3")), "https://raw.githubusercontent.com/byxhouhou/requirements-lifecycle-platform/main/public/skills/packages/sample-skill/1.2.3.zip");
  assert.throws(() => parseMetadata(skillText.replace("sample-skill", "../escape")), /name/);
});

test("a normal skill package imports and can be added to a catalog", async () => {
  const skill = await importSkill(await packageFile());
  const record = { ...toRecord({ ...skill, title: "Sample", author: "Team", category: "需求分析" }), publisher: "tester" };
  const catalog = mergeCatalog({ schemaVersion: 1, skills: [] }, record);
  assert.equal(skill.name, "sample-skill");
  assert.equal(skill.version, "1.2.3");
  assert.equal(skill.fileCount, 2);
  assert.equal(parseCatalog(catalog).skills[0].sha256, skill.sha256);
  assert.equal(mergeCatalog(catalog, record), catalog);
  assert.throws(() => mergeCatalog(catalog, { ...record, sha256: "0".repeat(64) }), /升级版本/);
});

test("unsafe archives and oversized expanded content are rejected", async () => {
  const unsafe = await packageFile({ "../secret.txt": "secret" });
  await assert.rejects(importSkill(unsafe), /不安全|改写/);

  const oversized = await packageFile({ "sample-skill/large.bin": new Uint8Array(21 * 1024 * 1024) });
  await assert.rejects(importSkill(oversized), /20 MB/);

  const valid = await packageFile();
  const buffer = await valid.arrayBuffer();
  assert.equal(inspectZipDirectory(buffer).size, 3);
});
test("publishing creates one atomic commit and never forces the shared branch", async () => {
  const skill = { ...await importSkill(await packageFile()), title: "Sample", author: "Team", category: "需求分析" };
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, authorization: new Headers(init.headers).get("authorization") });
    if (path.endsWith("/requirements-lifecycle-platform/")) return json({ full_name: DEFAULT_SOURCE.repository, private: false, default_branch: "main" });
    if (path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "head-sha" } });
    if (path.endsWith("/git/commits/head-sha")) return json({ tree: { sha: "base-tree" } });
    if (path.includes("/contents/public/skills/catalog.json?ref=head-sha")) return json({ message: "Not Found" }, 404);
    if (path.endsWith("/git/blobs")) return json({ sha: "package-blob" });
    if (path.endsWith("/git/trees")) return json({ sha: "next-tree" });
    if (path.endsWith("/git/commits")) return json({ sha: "next-commit" });
    if (path.endsWith("/git/refs/heads/main")) return json({ object: { sha: "next-commit" } });
    return json({ message: "Unexpected route" }, 500);
  };

  const result = await publishSkill(DEFAULT_SOURCE, skill, "test-token", fetcher);
  const treeCall = calls.find(call => call.path.endsWith("/git/trees"));
  const refCall = calls.find(call => call.path.endsWith("/git/refs/heads/main"));
  assert.equal(result.commit, "next-commit");
  assert.deepEqual(treeCall.body.tree.map(item => item.path), [skill.packagePath, "public/skills/catalog.json"]);
  assert.deepEqual(refCall.body, { sha: "next-commit", force: false });
  assert.ok(calls.every(call => call.authorization === "Bearer test-token"));
});
test("bundled catalog matches the published ZIP and includes the SOP flowchart", async () => {
  const catalogText = await readFile(new URL("../public/skills/catalog.json", import.meta.url), "utf8");
  const catalog = parseCatalog(JSON.parse(catalogText));
  const record = catalog.skills.find(item => item.id === "cockpit-requirements-analysis@0.4.0");
  assert.ok(record);
  const packageBytes = await readFile(new URL(`../${record.packagePath}`, import.meta.url));
  const packageBuffer = Uint8Array.from(packageBytes).buffer;
  assert.equal(packageBytes.byteLength, record.size);
  assert.equal(await sha256(packageBuffer), record.sha256);
  const skill = await importSkill(new File([packageBuffer], "cockpit-requirements-analysis.zip"));
  assert.equal(skill.name, record.name);
  assert.equal(skill.version, record.version);
  assert.match(skill.sopText, /flowchart TD/);
  assert.match(skill.sopText, /禁止模型查看图片/);
  assert.match(skill.skillText, /不得打开、渲染、预览、识别、OCR、描述、分类或推断任何图片/);
  assert.ok(skill.files.some(name => name.endsWith("assets/image-register.md")));
  assert.ok(!skill.files.some(name => name.endsWith("assets/image-transcription.md")));
  assert.ok(!catalog.skills.some(item => item.id === "cockpit-requirements-analysis@0.3.0"));
});
