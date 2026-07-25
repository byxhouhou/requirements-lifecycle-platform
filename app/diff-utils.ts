import JSZip from "jszip";

export type SnapshotFile = {
  name: string;
  format: string;
  size: number;
  lastModified: number;
  content: string;
  readable: boolean;
};

export type DiffRow = {
  leftNumber?: number;
  rightNumber?: number;
  left: string;
  right: string;
  type: "same" | "added" | "deleted" | "changed";
};

type SnapshotInput = {
  file: File;
  name: string;
  format: string;
  size: number;
};

const extractDocxText = async (file: File) => {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) return "";
  const xml = new DOMParser().parseFromString(documentXml, "application/xml");
  return Array.from(xml.getElementsByTagName("w:p"))
    .map(paragraph => Array.from(paragraph.getElementsByTagName("w:t")).map(node => node.textContent ?? "").join(""))
    .filter(line => line.trim())
    .join("\n");
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
      format: document.format,
      size: document.size,
      lastModified: document.file.lastModified,
      content: content.slice(0, 120_000),
      readable,
    };
  }));

const snapshotLines = (files: SnapshotFile[]) =>
  [...files]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .flatMap(file => [`══ ${file.name} ══`, ...file.content.split(/\r?\n/)])
    .slice(0, 1200);

export const compareSnapshots = (leftFiles: SnapshotFile[], rightFiles: SnapshotFile[]) => {
  const left = snapshotLines(leftFiles);
  const right = snapshotLines(rightFiles);
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      matrix[i][j] = left[i] === right[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const raw: Array<{ type: "same" | "added" | "deleted"; text: string; number: number }> = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      raw.push({ type: "same", text: left[i], number: i + 1 });
      i++; j++;
    } else if (j < right.length && (i >= left.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      raw.push({ type: "added", text: right[j], number: j + 1 });
      j++;
    } else {
      raw.push({ type: "deleted", text: left[i], number: i + 1 });
      i++;
    }
  }

  const result: DiffRow[] = [];
  let cursor = 0;
  let rightLine = 0;
  while (cursor < raw.length) {
    if (raw[cursor].type === "same") {
      rightLine++;
      result.push({
        leftNumber: raw[cursor].number,
        rightNumber: rightLine,
        left: raw[cursor].text,
        right: raw[cursor].text,
        type: "same",
      });
      cursor++;
      continue;
    }
    const deleted: typeof raw = [];
    const added: typeof raw = [];
    while (cursor < raw.length && raw[cursor].type !== "same") {
      if (raw[cursor].type === "deleted") deleted.push(raw[cursor]);
      else added.push(raw[cursor]);
      cursor++;
    }
    const blockSize = Math.max(deleted.length, added.length);
    for (let index = 0; index < blockSize; index++) {
      const oldLine = deleted[index];
      const newLine = added[index];
      if (newLine) rightLine++;
      result.push({
        leftNumber: oldLine?.number,
        rightNumber: newLine ? rightLine : undefined,
        left: oldLine?.text ?? "",
        right: newLine?.text ?? "",
        type: oldLine && newLine ? "changed" : oldLine ? "deleted" : "added",
      });
    }
  }

  return {
    rows: result,
    changed: result.filter(row => row.type === "changed").length,
    added: result.filter(row => row.type === "added").length,
    deleted: result.filter(row => row.type === "deleted").length,
    same: result.filter(row => row.type === "same").length,
  };
};
