import assert from "node:assert/strict";
import test from "node:test";
import { compareSnapshots } from "../.test-build/diff-utils.js";

const snapshot = (name, content, path = name) => ({
  name,
  path,
  format: "WORD",
  size: content.length,
  lastModified: 0,
  content,
  readable: true,
});

test("aligns modified, added and unchanged DOCX paragraphs by line", () => {
  const result = compareSnapshots(
    [snapshot("系统需求.docx", "系统应支持登录\n最大并发用户数为 100\n所有操作需要审计")],
    [snapshot("系统需求.docx", "系统应支持登录\n最大并发用户数为 200\n新增密码复杂度校验\n所有操作需要审计")],
  );

  assert.equal(result.changed, 1);
  assert.equal(result.added, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.same, 2);

  const changed = result.rows.find(row => row.type === "changed");
  assert.equal(changed?.leftNumber, 2);
  assert.equal(changed?.rightNumber, 2);
  assert.ok(changed?.leftSegments?.some(segment => segment.changed && segment.text.includes("1")));
  assert.ok(changed?.rightSegments?.some(segment => segment.changed && segment.text.includes("2")));

  const added = result.rows.find(row => row.type === "added");
  assert.equal(added?.rightNumber, 3);
  assert.equal(added?.right, "新增密码复杂度校验");
});

test("groups files independently and resets line numbers for each document", () => {
  const result = compareSnapshots(
    [
      snapshot("A.docx", "A1\nA2", "输入/A.docx"),
      snapshot("B.docx", "B1", "输入/B.docx"),
    ],
    [
      snapshot("A.docx", "A1\nA2", "输入/A.docx"),
      snapshot("B.docx", "B1\nB2", "输入/B.docx"),
    ],
  );

  const headers = result.rows.filter(row => row.type === "file");
  assert.equal(headers.length, 2);
  assert.equal(headers[0].fileStatus, "same");
  assert.equal(headers[1].fileStatus, "changed");

  const added = result.rows.find(row => row.type === "added");
  assert.equal(added?.fileKey, "输入/b.docx");
  assert.equal(added?.rightNumber, 2);
});

test("can ignore whitespace-only line differences", () => {
  const strict = compareSnapshots(
    [snapshot("A.docx", "需求编号 SRD-001")],
    [snapshot("A.docx", "需求编号   SRD-001")],
  );
  const relaxed = compareSnapshots(
    [snapshot("A.docx", "需求编号 SRD-001")],
    [snapshot("A.docx", "需求编号   SRD-001")],
    { ignoreWhitespace: true },
  );

  assert.equal(strict.changed, 1);
  assert.equal(relaxed.changed, 0);
  assert.equal(relaxed.same, 1);
});
