import JSZip from "jszip";
import { parseDocument } from "yaml";

export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 500;
const MAX_TEXT_BYTES = 512 * 1024;
export const CATALOG_PATH = "public/skills/catalog.json";
export const DEFAULT_SOURCE: SkillSource = { id: "reqflow", repository: "byxhouhou/requirements-lifecycle-platform", branch: "main" };

export type SkillSource = { id: string; repository: string; branch: string };
export type SkillRecord = {
  id: string; name: string; title: string; description: string; version: string;
  author: string; category: string; createdAt: string; fileCount: number;
  size: number; sha256: string; packagePath: string; publisher?: string;
};
export type SkillCatalog = { schemaVersion: 1; skills: SkillRecord[] };
export type LocalSkill = SkillRecord & { blob: Blob; skillText: string; readmeText: string; sopText: string; files: string[]; declaredVersion: boolean };
export type SkillMetadata = { name: string; description: string; version?: string };

export function validateVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value)) throw new Error("版本请使用 1.0.0 或 1.0.0-beta.1 格式");
  return value;
}
export function validateName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) throw new Error("Skill 的 name 必须为不超过 64 位的小写字母、数字和连字符");
  return value;
}
export function validateSource(source: SkillSource): SkillSource {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) throw new Error("仓库请填写 owner/repository");
  if (!source.branch || source.branch.length > 160 || /[\s?#\\~^:[\]*]/.test(source.branch) || source.branch.includes("..") || source.branch.startsWith("/") || source.branch.endsWith("/")) throw new Error("请填写有效的分支名称");
  return { id: source.id, repository: source.repository, branch: source.branch };
}
export function packagePath(name: string, version: string): string {
  return `public/skills/packages/${validateName(name)}/${validateVersion(version)}.zip`;
}
export function rawUrl(source: SkillSource, path: string, ref = source.branch): string {
  validateSource(source);
  if (!/^public\/skills\/(?:catalog\.json|packages\/[a-z0-9-]+\/[A-Za-z0-9.-]+\.zip)$/.test(path)) throw new Error("Skill 文件路径无效");
  return `https://raw.githubusercontent.com/${source.repository}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
export function parseMetadata(text: string): SkillMetadata {
  const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("SKILL.md 需要 YAML 头部，包含 name 和 description");
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error("SKILL.md 的 YAML 头部格式有误");
  const data = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  if (!data || typeof data !== "object" || typeof data.name !== "string" || typeof data.description !== "string") throw new Error("SKILL.md 缺少有效的 name 或 description");
  const name = validateName(data.name.trim());
  const description = data.description.trim();
  if (!description || description.length > 1024) throw new Error("description 不能为空，且不能超过 1024 字");
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  const version = metadata.version ?? data.version;
  if (version !== undefined && typeof version !== "string") throw new Error("Skill 版本应写成字符串");
  return { name, description, version: typeof version === "string" ? validateVersion(version) : undefined };
}
export function parseCatalog(value: unknown): SkillCatalog {
  if (!value || typeof value !== "object") throw new Error("目录格式无效");
  const data = value as { schemaVersion?: number; skills?: unknown[] };
  if (data.schemaVersion !== 1 || !Array.isArray(data.skills) || data.skills.length > 1000) throw new Error("不支持的 Skill 目录格式或目录条目过多");
  const ids = new Set<string>();
  const skills = data.skills.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("目录条目无效");
    const item = raw as SkillRecord;
    for (const field of ["name", "title", "description", "version", "author", "category", "createdAt", "sha256", "packagePath", "id"] as const) {
      if (typeof item[field] !== "string") throw new Error("目录条目缺少必要信息");
    }
    validateName(item.name); validateVersion(item.version);
    if (item.id !== `${item.name}@${item.version}` || ids.has(item.id)) throw new Error("目录包含重复或无效编号");
    ids.add(item.id);
    if (!item.title.trim() || item.title.length > 120 || !item.description.trim() || item.description.length > 1024 || item.author.length > 120 || item.category.length > 60) throw new Error("目录文字长度无效");
    if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isInteger(item.size) || item.size < 1 || item.size > MAX_PACKAGE_BYTES || !Number.isInteger(item.fileCount) || item.fileCount < 1 || item.fileCount > MAX_FILES) throw new Error("目录大小、文件数量或日期无效");
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.packagePath !== packagePath(item.name, item.version)) throw new Error("目录文件路径或校验值无效");
    return { id: item.id, name: item.name, title: item.title, description: item.description, version: item.version, author: item.author, category: item.category, createdAt: item.createdAt, fileCount: item.fileCount, size: item.size, sha256: item.sha256, packagePath: item.packagePath, ...(typeof item.publisher === "string" ? { publisher: item.publisher.slice(0, 120) } : {}) };
  });
  return { schemaVersion: 1, skills };
}
export function toRecord(skill: LocalSkill): SkillRecord {
  return { id: `${skill.name}@${skill.version}`, name: validateName(skill.name), title: skill.title.trim(), description: skill.description.trim(), version: validateVersion(skill.version), author: skill.author.trim(), category: skill.category.trim() || "其他", createdAt: skill.createdAt, fileCount: skill.fileCount, size: skill.blob.size, sha256: skill.sha256, packagePath: packagePath(skill.name, skill.version) };
}
export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function safeArchivePath(name: string): boolean {
  return !!name && !name.startsWith("/") && !/[\\:\u0000-\u001f]/.test(name)
    && !name.split("/").some(part => part === ".." || part === "." || part === ".git" || /^\.env(?:\.|$)/i.test(part))
    && !/\.(?:pem|key)$/i.test(name);
}
// Inspect sizes before decompression and reject ambiguous/unsafe archives.
export function inspectZipDirectory(buffer: ArrayBuffer): Map<string, number> {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw new Error("ZIP 文件不完整");
  const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), directorySize = view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count > MAX_FILES || !count || offset + directorySize !== end) throw new Error("ZIP 条目过多或采用不支持的分卷／ZIP64 格式");
  let at = offset, total = 0;
  const sizes = new Map<string, number>(), names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error("ZIP 目录损坏");
    const flags = view.getUint16(at + 8, true), compression = view.getUint16(at + 10, true);
    const expanded = view.getUint32(at + 24, true), compressed = view.getUint32(at + 20, true);
    const nameSize = view.getUint16(at + 28, true), extraSize = view.getUint16(at + 30, true), commentSize = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true), mode = view.getUint32(at + 38, true) >>> 16;
    if (at + 46 + nameSize + extraSize + commentSize > end || localOffset + 30 > offset || (flags & 1) || ![0, 8].includes(compression) || (mode & 0xf000) === 0xa000) throw new Error("ZIP 含加密、链接或不支持的条目");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameSize));
    if (!safeArchivePath(name) || names.has(name.toLowerCase())) throw new Error("ZIP 含不安全、重复或敏感文件路径");
    if (view.getUint32(localOffset, true) !== 0x04034b50 || localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true) + compressed > offset) throw new Error("ZIP 数据边界无效");
    names.add(name.toLowerCase()); sizes.set(name, expanded); total += expanded;
    if (total > MAX_EXPANDED_BYTES) throw new Error("ZIP 解压后不能超过 20 MB");
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end) throw new Error("ZIP 目录长度无效");
  return sizes;
}
async function inspectText(zip: JSZip, sizes: Map<string, number>, wanted: Set<string>): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const original = entry.unsafeOriginalName || entry.name;
    if (entry.name !== original || !sizes.has(original)) throw new Error("ZIP 路径被改写或无法核对");
    const collect = wanted.has(entry.name);
    let actual = 0;
    const parts: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = (entry as unknown as {
        internalStream: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
      }).internalStream("uint8array");
      let failed = false;
      stream.on("data", chunk => {
        if (failed) return;
        actual += chunk.byteLength; total += chunk.byteLength;
        if (total > MAX_EXPANDED_BYTES || actual > (sizes.get(original) ?? 0) || (collect && actual > MAX_TEXT_BYTES)) {
          failed = true; stream.pause(); reject(new Error("ZIP 实际内容超过限制，或预览文档大于 512 KB")); return;
        }
        if (collect) parts.push(chunk);
      }).on("error", reject).on("end", () => {
        if (failed) return;
        if (actual !== sizes.get(original)) reject(new Error("ZIP 文件大小不一致"));
        else resolve();
      }).resume();
    });
    if (collect) {
      const data = new Uint8Array(actual); let offset = 0;
      for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
      texts.set(entry.name, new TextDecoder("utf-8", { fatal: true }).decode(data));
    }
  }
  return texts;
}
export async function importSkill(file: File): Promise<LocalSkill> {
  if (!file.size || file.size > MAX_PACKAGE_BYTES) throw new Error("请选择不超过 5 MB 的 ZIP 或 SKILL.md 文件");
  let buffer: ArrayBuffer, zip: JSZip;
  if (/\.md$/i.test(file.name)) {
    if (file.size > MAX_TEXT_BYTES) throw new Error("SKILL.md 不能超过 512 KB");
    const text = await file.text(), meta = parseMetadata(text);
    zip = new JSZip(); zip.file(`${meta.name}/SKILL.md`, text);
    buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  } else if (/\.zip$/i.test(file.name)) {
    buffer = await file.arrayBuffer();
  } else throw new Error("只支持 ZIP 包或包含完整 YAML 头部的 Markdown 文件");
  const sizes = inspectZipDirectory(buffer);
  zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(item => !item.dir);
  const skillFiles = entries.filter(item => /(^|\/)SKILL\.md$/.test(item.name));
  if (skillFiles.length !== 1) throw new Error("一个上传包必须且只能包含一个 SKILL.md");
  const skillPath = skillFiles[0].name, prefix = skillPath.slice(0, -"SKILL.md".length);
  if (prefix.split("/").filter(Boolean).length > 1 || entries.some(item => !item.name.startsWith(prefix))) throw new Error("请使用根目录或单层文件夹包含 SKILL.md 及资源，避免混入其他目录");
  const readmePath = prefix + "README.md", sopPath = prefix + "SOP.md", versionPath = prefix + "VERSION";
  const texts = await inspectText(zip, sizes, new Set([skillPath, readmePath, sopPath, versionPath]));
  const skillText = texts.get(skillPath) || "", metadata = parseMetadata(skillText);
  const fileVersion = texts.get(versionPath)?.trim();
  if (fileVersion && metadata.version && fileVersion !== metadata.version) throw new Error("VERSION 与 SKILL.md 的版本不一致");
  const version = validateVersion(metadata.version || fileVersion || "0.1.0");
  const firstHeading = texts.get(readmePath)?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const result: LocalSkill = {
    id: `${metadata.name}@${version}`, name: metadata.name, title: (firstHeading || metadata.name).slice(0, 120),
    description: metadata.description, version, author: "", category: "其他",
    createdAt: new Date().toISOString(), fileCount: entries.length, size: buffer.byteLength,
    sha256: await sha256(buffer), packagePath: packagePath(metadata.name, version),
    blob: new Blob([buffer], { type: "application/zip" }), skillText,
    readmeText: texts.get(readmePath) || "", sopText: texts.get(sopPath) || "",
    files: entries.map(item => item.name).sort(), declaredVersion: !!(metadata.version || fileVersion),
  };
  parseCatalog({ schemaVersion: 1, skills: [toRecord(result)] });
  return result;
}
export function mergeCatalog(catalog: SkillCatalog, record: SkillRecord): SkillCatalog {
  parseCatalog({ schemaVersion: 1, skills: [record] });
  const existing = catalog.skills.find(item => item.id === record.id);
  if (existing) {
    if (existing.sha256 !== record.sha256) throw new Error("此 Skill 的同名版本已存在，请在包内升级版本后发布");
    return catalog;
  }
  return parseCatalog({ schemaVersion: 1, skills: [record, ...catalog.skills] });
}
