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

test("Myers precise mode returns a shortest line edit path", () => {
  const referenceLcs = (left, right) => {
    const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        matrix[i][j] = left[i] === right[j]
          ? matrix[i + 1][j + 1] + 1
          : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
    return matrix[0][0];
  };

  let seed = 20260725;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  for (let sample = 0; sample < 80; sample++) {
    const left = Array.from({ length: 3 + Math.floor(random() * 8) }, () => `L${Math.floor(random() * 6)}`);
    const right = Array.from({ length: 3 + Math.floor(random() * 8) }, () => `L${Math.floor(random() * 6)}`);
    const result = compareSnapshots(
      [snapshot("随机需求.docx", left.join("\n"))],
      [snapshot("随机需求.docx", right.join("\n"))],
      { algorithm: "precise" },
    );
    assert.equal(result.same, referenceLcs(left, right));

    const body = result.rows.filter(row => row.type !== "file");
    assert.deepEqual(
      body.filter(row => row.leftNumber).map(row => row.left),
      left,
    );
    assert.deepEqual(
      body.filter(row => row.rightNumber).map(row => row.right),
      right,
    );
  }
});

test("balanced and fast modes keep stable anchors around large insertions", () => {
  const base = [
    "1 范围",
    "通用说明",
    "REQ-001 用户登录",
    "通用说明",
    "REQ-002 权限校验",
    "通用说明",
    "REQ-003 操作审计",
  ];
  const inserted = Array.from({ length: 120 }, (_, index) => `新增需求 NEW-${String(index + 1).padStart(3, "0")}`);
  const target = [...base.slice(0, 4), ...inserted, ...base.slice(4)];

  for (const algorithm of ["balanced", "fast"]) {
    const result = compareSnapshots(
      [snapshot("系统需求.docx", base.join("\n"))],
      [snapshot("系统需求.docx", target.join("\n"))],
      { algorithm },
    );
    assert.equal(result.same, base.length);
    assert.equal(result.added, inserted.length);
    assert.equal(result.changed, 0);
    assert.equal(result.deleted, 0);
  }
});
