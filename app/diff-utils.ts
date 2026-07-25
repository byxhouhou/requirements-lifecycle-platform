import JSZip from "jszip";

export type SnapshotFile = {
  name: string;
  path?: string;
  format: string;
  size: number;
  lastModified: number;
  content: string;
  readable: boolean;
};

export type DiffSegment = {
  text: string;
  changed: boolean;
};

export type DiffRow = {
  id: string;
  fileKey: string;
  leftNumber?: number;
  rightNumber?: number;
  left: string;
  right: string;
  type: "file" | "same" | "added" | "deleted" | "changed";
  leftSegments?: DiffSegment[];
  rightSegments?: DiffSegment[];
  fileStatus?: "same" | "added" | "deleted" | "changed";
  comparisonMode?: "content" | "metadata";
};

type SnapshotInput = {
  file: File;
  name: string;
  path?: string;
  format: string;
  size: number;
};

type RawDiff = {
  type: "same" | "added" | "deleted";
  left: string;
  right: string;
  leftNumber?: number;
  rightNumber?: number;
};

type CompareOptions = {
  ignoreWhitespace?: boolean;
};

const MAX_LINES_PER_FILE = 2000;
const MAX_INLINE_DIFF_LENGTH = 600;

const extractDocxText = async (file: File) => {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) return "";
  const xml = new DOMParser().parseFromString(documentXml, "application/xml");
  const lines = Array.from(xml.getElementsByTagName("w:p"))
    .map(paragraph => Array.from(paragraph.getElementsByTagName("w:t")).map(node => node.textContent ?? "").join(""));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines.join("\n");
};

export const snapshotDocuments = async (documents: SnapshotInput[]): Promise<SnapshotFile[]> =>
  Promise.all(documents.map(async document => {
    const isDocx = /\.docx$/i.test(document.name);
    let content = "";
    if (isDocx) {
      try {
        content = await extractDocxText(document.file);
      } catch {
        content = "";
      }
    }
    const readable = Boolean(content);
    if (!readable) {
      content = `[${document.format} 文件] ${document.name}\n大小：${document.size} 字节\n最后修改：${new Date(document.file.lastModified).toISOString()}`;
    }
    return {
      name: document.name,
      path: document.path,
      format: document.format,
      size: document.size,
      lastModified: document.file.lastModified,
      content: content.slice(0, 120_000),
      readable,
    };
  }));

const splitLines = (content: string) => {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length <= MAX_LINES_PER_FILE) return lines;
  return [
    ...lines.slice(0, MAX_LINES_PER_FILE),
    `… 内容超过 ${MAX_LINES_PER_FILE} 行，后续内容未载入对比`,
  ];
};

const normalizeLine = (line: string, options: CompareOptions) =>
  options.ignoreWhitespace ? line.replace(/\s+/g, "") : line;

const pushSegment = (segments: DiffSegment[], text: string, changed: boolean) => {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.changed === changed) {
    last.text += text;
  } else {
    segments.push({ text, changed });
  }
};

const inlineDiff = (leftText: string, rightText: string) => {
  const left = Array.from(leftText);
  const right = Array.from(rightText);
  if (left.length > MAX_INLINE_DIFF_LENGTH || right.length > MAX_INLINE_DIFF_LENGTH) {
    return {
      leftSegments: [{ text: leftText, changed: true }],
      rightSegments: [{ text: rightText, changed: true }],
    };
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      matrix[i][j] = left[i] === right[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      pushSegment(leftSegments, left[i], false);
      pushSegment(rightSegments, right[j], false);
      i++; j++;
    } else if (j < right.length && (i >= left.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      pushSegment(rightSegments, right[j], true);
      j++;
    } else {
      pushSegment(leftSegments, left[i], true);
      i++;
    }
  }
  return { leftSegments, rightSegments };
};

const lineSimilarity = (left: string, right: string) => {
  const a = left.replace(/\s+/g, "").toLocaleLowerCase();
  const b = right.replace(/\s+/g, "").toLocaleLowerCase();
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;

  const bigrams = (value: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index++) {
      const pair = value.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };

  const leftPairs = bigrams(a);
  const rightPairs = bigrams(b);
  let overlap = 0;
  leftPairs.forEach((count, pair) => {
    overlap += Math.min(count, rightPairs.get(pair) ?? 0);
  });
  return (2 * overlap) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
};

const buildRawDiff = (left: string[], right: string[], options: CompareOptions) => {
  const normalizedLeft = left.map(line => normalizeLine(line, options));
  const normalizedRight = right.map(line => normalizeLine(line, options));
  let prefix = 0;
  while (
    prefix < left.length
    && prefix < right.length
    && normalizedLeft[prefix] === normalizedRight[prefix]
  ) prefix++;

  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && normalizedLeft[left.length - 1 - suffix] === normalizedRight[right.length - 1 - suffix]
  ) suffix++;

  const leftMiddle = normalizedLeft.slice(prefix, left.length - suffix);
  const rightMiddle = normalizedRight.slice(prefix, right.length - suffix);
  const matrix = Array.from(
    { length: leftMiddle.length + 1 },
    () => new Uint16Array(rightMiddle.length + 1),
  );
  for (let i = leftMiddle.length - 1; i >= 0; i--) {
    for (let j = rightMiddle.length - 1; j >= 0; j--) {
      matrix[i][j] = leftMiddle[i] === rightMiddle[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const raw: RawDiff[] = [];
  for (let index = 0; index < prefix; index++) {
    raw.push({
      type: "same",
      left: left[index],
      right: right[index],
      leftNumber: index + 1,
      rightNumber: index + 1,
    });
  }

  let i = 0;
  let j = 0;
  while (i < leftMiddle.length || j < rightMiddle.length) {
    if (
      i < leftMiddle.length
      && j < rightMiddle.length
      && leftMiddle[i] === rightMiddle[j]
    ) {
      raw.push({
        type: "same",
        left: left[prefix + i],
        right: right[prefix + j],
        leftNumber: prefix + i + 1,
        rightNumber: prefix + j + 1,
      });
      i++; j++;
    } else if (
      j < rightMiddle.length
      && (i >= leftMiddle.length || matrix[i][j + 1] >= matrix[i + 1][j])
    ) {
      raw.push({
        type: "added",
        left: "",
        right: right[prefix + j],
        rightNumber: prefix + j + 1,
      });
      j++;
    } else {
      raw.push({
        type: "deleted",
        left: left[prefix + i],
        right: "",
        leftNumber: prefix + i + 1,
      });
      i++;
    }
  }

  for (let index = suffix; index > 0; index--) {
    const leftIndex = left.length - index;
    const rightIndex = right.length - index;
    raw.push({
      type: "same",
      left: left[leftIndex],
      right: right[rightIndex],
      leftNumber: leftIndex + 1,
      rightNumber: rightIndex + 1,
    });
  }
  return raw;
};

const alignChangeBlock = (deleted: RawDiff[], added: RawDiff[]) => {
  if (!deleted.length) return added.map(row => ({ ...row, type: "added" as const }));
  if (!added.length) return deleted.map(row => ({ ...row, type: "deleted" as const }));

  const rows = deleted.length + 1;
  const columns = added.length + 1;
  const costs = Array.from({ length: rows }, () => new Float64Array(columns));
  const choices = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (let i = 1; i < rows; i++) {
    costs[i][0] = i;
    choices[i][0] = 2;
  }
  for (let j = 1; j < columns; j++) {
    costs[0][j] = j;
    choices[0][j] = 3;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const similarity = lineSimilarity(deleted[i - 1].left, added[j - 1].right);
      const changeCost = costs[i - 1][j - 1] + (similarity >= 0.28 ? 1.5 - similarity : 2.1);
      const deleteCost = costs[i - 1][j] + 1;
      const addCost = costs[i][j - 1] + 1;
      if (changeCost < deleteCost && changeCost < addCost) {
        costs[i][j] = changeCost;
        choices[i][j] = 1;
      } else if (addCost <= deleteCost) {
        costs[i][j] = addCost;
        choices[i][j] = 3;
      } else {
        costs[i][j] = deleteCost;
        choices[i][j] = 2;
      }
    }
  }

  const aligned: Array<Omit<DiffRow, "id" | "fileKey">> = [];
  let i = deleted.length;
  let j = added.length;
  while (i > 0 || j > 0) {
    const choice = choices[i][j];
    if (choice === 1) {
      const oldLine = deleted[i - 1];
      const newLine = added[j - 1];
      aligned.push({
        leftNumber: oldLine.leftNumber,
        rightNumber: newLine.rightNumber,
        left: oldLine.left,
        right: newLine.right,
        type: "changed",
        ...inlineDiff(oldLine.left, newLine.right),
      });
      i--; j--;
    } else if (choice === 2) {
      const oldLine = deleted[i - 1];
      aligned.push({
        leftNumber: oldLine.leftNumber,
        left: oldLine.left,
        right: "",
        type: "deleted",
      });
      i--;
    } else {
      const newLine = added[j - 1];
      aligned.push({
        rightNumber: newLine.rightNumber,
        left: "",
        right: newLine.right,
        type: "added",
      });
      j--;
    }
  }
  return aligned.reverse();
};

const createFileRows = (
  leftFile: SnapshotFile | undefined,
  rightFile: SnapshotFile | undefined,
  fileKey: string,
  fileIndex: number,
  options: CompareOptions,
) => {
  const leftLines = leftFile ? splitLines(leftFile.content) : [];
  const rightLines = rightFile ? splitLines(rightFile.content) : [];
  let body: Array<Omit<DiffRow, "id" | "fileKey">>;

  if (!leftFile) {
    body = rightLines.map((line, index) => ({
      rightNumber: index + 1,
      left: "",
      right: line,
      type: "added",
    }));
  } else if (!rightFile) {
    body = leftLines.map((line, index) => ({
      leftNumber: index + 1,
      left: line,
      right: "",
      type: "deleted",
    }));
  } else {
    const raw = buildRawDiff(leftLines, rightLines, options);
    body = [];
    let cursor = 0;
    while (cursor < raw.length) {
      if (raw[cursor].type === "same") {
        const row = raw[cursor];
        body.push({
          leftNumber: row.leftNumber,
          rightNumber: row.rightNumber,
          left: row.left,
          right: row.right,
          type: "same",
        });
        cursor++;
        continue;
      }
      const deleted: RawDiff[] = [];
      const added: RawDiff[] = [];
      while (cursor < raw.length && raw[cursor].type !== "same") {
        if (raw[cursor].type === "deleted") deleted.push(raw[cursor]);
        else added.push(raw[cursor]);
        cursor++;
      }
      body.push(...alignChangeBlock(deleted, added));
    }
  }

  const fileStatus = !leftFile
    ? "added"
    : !rightFile
      ? "deleted"
      : body.some(row => row.type !== "same")
        ? "changed"
        : "same";
  const comparisonMode = leftFile?.readable && rightFile?.readable ? "content" : "metadata";
  const header: DiffRow = {
    id: `file-${fileIndex}`,
    fileKey,
    left: leftFile?.path || leftFile?.name || "",
    right: rightFile?.path || rightFile?.name || "",
    type: "file",
    fileStatus,
    comparisonMode,
  };
  return [
    header,
    ...body.map((row, rowIndex): DiffRow => ({
      ...row,
      id: `diff-${fileIndex}-${rowIndex}`,
      fileKey,
    })),
  ];
};

const snapshotKey = (file: SnapshotFile) => (file.path || file.name).replaceAll("\\", "/").toLocaleLowerCase();

export const compareSnapshots = (
  leftFiles: SnapshotFile[],
  rightFiles: SnapshotFile[],
  options: CompareOptions = {},
) => {
  const leftByKey = new Map(leftFiles.map(file => [snapshotKey(file), file]));
  const rightByKey = new Map(rightFiles.map(file => [snapshotKey(file), file]));
  const fileKeys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const result = fileKeys.flatMap((fileKey, index) =>
    createFileRows(leftByKey.get(fileKey), rightByKey.get(fileKey), fileKey, index, options));

  return {
    rows: result,
    changed: result.filter(row => row.type === "changed").length,
    added: result.filter(row => row.type === "added").length,
    deleted: result.filter(row => row.type === "deleted").length,
    same: result.filter(row => row.type === "same").length,
  };
};
