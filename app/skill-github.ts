import { CATALOG_PATH, importSkill, mergeCatalog, parseCatalog, rawUrl, sha256, toRecord, validateSource, type LocalSkill, type SkillCatalog, type SkillRecord, type SkillSource } from "./skill-utils.js";

const API = "https://api.github.com";
export type PublicRepository = { full_name: string; private: boolean; default_branch: string; permissions?: { push?: boolean } };
export type Fetcher = typeof fetch;
export class GitHubError extends Error { constructor(message: string, public status: number) { super(message); } }
function statusMessage(status: number): string {
  if (status === 401) return "GitHub 授权无效或已过期";
  if (status === 403) return "GitHub 权限不足或请求次数受限，请检查仓库 Contents 写权限";
  if (status === 404) return "未找到公开仓库、分支或目录，请检查来源设置";
  if (status === 409 || status === 422) return "仓库已更新或分支受保护，本次未发布；请刷新后重试，或通过仓库合并流程投稿";
  return "GitHub 请求未完成，请检查网络后重试";
}
async function api<T>(source: SkillSource, path: string, token: string, method = "GET", body?: unknown, fetcher: Fetcher = fetch): Promise<T> {
  validateSource(source);
  const response = await fetcher(`${API}/repos/${source.repository}/${path}`, {
    method, headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), cache: "no-store", redirect: "error",
  });
  if (!response.ok) throw new GitHubError(statusMessage(response.status), response.status);
  return response.json() as Promise<T>;
}
export const getRepository = (source: SkillSource, token = "", fetcher: Fetcher = fetch) => api<PublicRepository>(source, "", token, "GET", undefined, fetcher);
export function encodeBase64(bytes: Uint8Array): string {
  let result = ""; for (let at = 0; at < bytes.length; at += 16384) result += String.fromCharCode(...bytes.subarray(at, at + 16384));
  return btoa(result);
}
function decodeContent(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), character => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export async function loadGitHubCatalog(source: SkillSource, token = "", ref = source.branch, allowMissing = false, fetcher: Fetcher = fetch): Promise<SkillCatalog> {
  try {
    const content = await api<{ content: string; encoding: string; size: number }>(source, `contents/${CATALOG_PATH}?ref=${encodeURIComponent(ref)}`, token, "GET", undefined, fetcher);
    if (content.encoding !== "base64" || content.size > 1024 * 1024) throw new Error("共享目录过大或文件编码无效");
    return parseCatalog(JSON.parse(decodeContent(content.content)));
  } catch (error) {
    if (allowMissing && error instanceof GitHubError && error.status === 404) return { schemaVersion: 1, skills: [] };
    throw error;
  }
}
export async function downloadSharedSkill(source: SkillSource, record: SkillRecord, bundled = false): Promise<LocalSkill> {
  const url = bundled ? "/" + record.packagePath.replace(/^public\//, "") : rawUrl(source, record.packagePath);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("下载失败，请检查网络或刷新共享目录");
  const declared = Number(response.headers.get("content-length"));
  if (declared > record.size) throw new Error("下载文件大小与目录不一致");
  if (!response.body) throw new Error("未收到下载内容");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > record.size) throw new Error("下载文件超过目录声明大小");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.byteLength; }
  if (size !== record.size || await sha256(buffer.buffer) !== record.sha256) throw new Error("文件校验失败，请刷新目录后重试");
  const skill = await importSkill(new File([buffer], `${record.name}.zip`));
  if (skill.name !== record.name || (skill.declaredVersion && skill.version !== record.version)) throw new Error("包内 Skill 名称或版本与目录不一致");
  return { ...skill, ...record };
}
export async function publishSkill(source: SkillSource, skill: LocalSkill, token: string, fetcher: Fetcher = fetch): Promise<{ record: SkillRecord; commit: string; alreadyPublished: boolean }> {
  if (!token.trim()) throw new Error("发布需要有仓库写权限的 GitHub 访问令牌");
  const repo = await getRepository(source, token, fetcher);
  if (repo.private) throw new Error("当前共享目录面向公开仓库，请选择用于团队公开分发的仓库");
  const head = await api<{ object: { sha: string } }>(source, `git/ref/heads/${encodeURIComponent(source.branch)}`, token, "GET", undefined, fetcher);
  const commit = await api<{ tree: { sha: string } }>(source, `git/commits/${head.object.sha}`, token, "GET", undefined, fetcher);
  const catalog = await loadGitHubCatalog(source, token, head.object.sha, true, fetcher);
  const record = toRecord(skill);
  const next = mergeCatalog(catalog, record);
  if (next === catalog) return { record: catalog.skills.find(item => item.id === record.id)!, commit: head.object.sha, alreadyPublished: true };
  // A package and its catalog entry become visible together in one non-forced commit.
  const bytes = new Uint8Array(await skill.blob.arrayBuffer());
  if (bytes.byteLength !== record.size || await sha256(bytes.buffer) !== record.sha256) throw new Error("本机 Skill 包校验失败，请重新上传");
  const blob = await api<{ sha: string }>(source, "git/blobs", token, "POST", { content: encodeBase64(bytes), encoding: "base64" }, fetcher);
  const tree = await api<{ sha: string }>(source, "git/trees", token, "POST", { base_tree: commit.tree.sha, tree: [
    { path: record.packagePath, mode: "100644", type: "blob", sha: blob.sha },
    { path: CATALOG_PATH, mode: "100644", type: "blob", content: JSON.stringify(next, null, 2) + "\n" },
  ] }, fetcher);
  const created = await api<{ sha: string }>(source, "git/commits", token, "POST", { message: `Publish skill ${record.name} v${record.version}`, tree: tree.sha, parents: [head.object.sha] }, fetcher);
  try {
    await api(source, `git/refs/heads/${encodeURIComponent(source.branch)}`, token, "PATCH", { sha: created.sha, force: false }, fetcher);
  } catch (error) {
    // Resolve a lost response before reporting failure. Never force a stale branch.
    try {
      const actual = await loadGitHubCatalog(source, token, source.branch, false, fetcher);
      const found = actual.skills.find(item => item.id === record.id && item.sha256 === record.sha256);
      if (found) return { record: found, commit: created.sha, alreadyPublished: false };
    } catch { /* Preserve the original failure. */ }
    throw error;
  }
  return { record, commit: created.sha, alreadyPublished: false };
}
