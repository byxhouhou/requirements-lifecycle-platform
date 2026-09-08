import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DEFAULT_SOURCE, importSkill, parseCatalog, toRecord, validateSource, validateVersion, type LocalSkill, type SkillRecord, type SkillSource } from "./skill-utils";
import { deleteSkill, readSkills, saveSkill } from "./skill-storage";
import { downloadSharedSkill, getRepository, loadGitHubCatalog, publishSkill, type PublicRepository } from "./skill-github";
import "./skill-library.css";

const SOURCES_KEY = "reqflow-skill-sources-v1";
type SharedItem = { record: SkillRecord; source: SkillSource; bundled: boolean };
function initialSources(): SkillSource[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) || "null");
    if (Array.isArray(saved) && saved.length) return saved.map(validateSource);
  } catch { /* An invalid preference must not prevent opening the library. */ }
  return [DEFAULT_SOURCE];
}
const displaySize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function SkillLibrary({ onBack }: { onBack: () => void }) {
  const [local, setLocal] = useState<LocalSkill[]>([]);
  const [shared, setShared] = useState<SharedItem[]>([]);
  const [sources, setSources] = useState<SkillSource[]>(initialSources);
  const [sourceId, setSourceId] = useState(() => initialSources()[0].id);
  const [showSources, setShowSources] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const [branchInput, setBranchInput] = useState("main");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [category, setCategory] = useState("全部分类");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<LocalSkill | null>(null);
  const [preview, setPreview] = useState<LocalSkill | null>(null);
  const [previewTab, setPreviewTab] = useState("SKILL.md");
  const [publishing, setPublishing] = useState<LocalSkill | null>(null);
  const [repository, setRepository] = useState<PublicRepository | null>(null);
  const [token, setToken] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const publishDialog = useRef<HTMLDialogElement>(null);
  const downloadCache = useRef(new Map<string, LocalSkill>());
  const source = sources.find(item => item.id === sourceId) || sources[0];
  function fail(reason: unknown) { setError(reason instanceof Error ? reason.message : "操作未完成，请重试"); }
  function resetNotice() { setError(""); setMessage(""); }
  useEffect(() => {
    let active = true;
    void readSkills().then(items => { if (active) setLocal(items); }).catch(reason => { if (active) fail(reason); });
    void fetch("/skills/catalog.json").then(async response => {
      if (!response.ok) throw new Error("随工具提供的 Skill 目录未找到，可使用“刷新共享目录”获取");
      const catalog = parseCatalog(await response.json());
      if (active) setShared(catalog.skills.map(record => ({ record, source: DEFAULT_SOURCE, bundled: true })));
    }).catch(reason => { if (active) fail(reason); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (preview) previewDialog.current?.showModal(); }, [preview]);
  useEffect(() => {
    setRepository(null);
    if (!publishing) return;
    publishDialog.current?.showModal();
    let active = true;
    void getRepository(source).then(info => { if (active) setRepository(info); }).catch(reason => { if (active) fail(reason); });
    return () => { active = false; };
  }, [publishing, source.repository, source.branch]);
  function rememberSources(next: SkillSource[]) {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(next)); setSources(next);
  }
  async function upload(file?: File) {
    if (!file) return; resetNotice(); setBusy("upload");
    try { setDraft(await importSkill(file)); setMessage("已检查 Skill 包，请核对名称和分类后保存"); }
    catch (reason) { fail(reason); }
    finally { setBusy(""); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); if (!draft) return; resetNotice(); setBusy("save");
    try {
      const value = { ...draft, ...toRecord(draft) };
      parseCatalog({ schemaVersion: 1, skills: [value] });
      const existing = local.find(item => item.id === value.id);
      if (existing && existing.sha256 !== value.sha256) throw new Error("本机已有不同内容的同名版本，请先在包内升级版本");
      await saveSkill(value); setLocal(items => [value, ...items.filter(item => item.id !== value.id)]);
      setDraft(null); setMessage("已保存到本机；点击“发布到共享目录”后团队成员才能下载");
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  }
  async function refresh() {
    resetNotice(); setBusy("refresh");
    try {
      const info = await getRepository(source);
      if (info.private) throw new Error("当前版本支持公开 GitHub 共享目录");
      const catalog = await loadGitHubCatalog(source);
      setShared(items => [...items.filter(item => item.source.id !== source.id), ...catalog.skills.map(record => ({ record, source, bundled: false }))]);
      setMessage(`已更新 ${source.repository}，共 ${catalog.skills.length} 个版本`);
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  }
  async function sharedAction(item: SharedItem, action: "preview" | "download") {
    resetNotice(); setBusy(item.source.id + item.record.id);
    try {
      let skill = downloadCache.current.get(item.record.sha256);
      if (!skill) { skill = await downloadSharedSkill(item.source, item.record, item.bundled); downloadCache.current.set(item.record.sha256, skill); }
      if (action === "preview") { setPreviewTab("SKILL.md"); setPreview(skill); }
      else { download(skill.blob, `${skill.name}-v${skill.version}.zip`); setMessage("校验通过，已开始下载"); }
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  }
  async function remove(skill: LocalSkill) {
    if (!window.confirm(`从本机移除“${skill.title}”？已发布到 GitHub 的版本不会删除。`)) return;
    resetNotice();
    try { await deleteSkill(skill.id); setLocal(items => items.filter(item => item.id !== skill.id)); setMessage("已从本机移除"); }
    catch (reason) { fail(reason); }
  }
  function closePublish() {
    if (busy === "publish") return;
    setToken(""); setPublishing(null); setRepository(null); publishDialog.current?.close();
  }
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!publishing || !repository || repository.private) return;
    resetNotice(); setBusy("publish");
    try {
      const result = await publishSkill(source, publishing, token.trim());
      setShared(items => [{ record: result.record, source, bundled: false }, ...items.filter(item => !(item.source.id === source.id && item.record.id === result.record.id))]);
      setMessage(result.alreadyPublished ? "这个版本已经在共享目录中，无需重复发布" : "已发布到 GitHub 共享目录，团队成员刷新后即可下载");
      setPublishing(null); setRepository(null); publishDialog.current?.close();
    } catch (reason) { fail(reason); } finally { setToken(""); setBusy(""); }
  }
  function addSource(event: FormEvent) {
    event.preventDefault(); resetNotice();
    try {
      const next = validateSource({ id: crypto.randomUUID(), repository: repoInput.trim(), branch: branchInput.trim() });
      if (sources.some(item => item.repository === next.repository && item.branch === next.branch)) throw new Error("这个来源已存在");
      rememberSources([...sources, next]); setSourceId(next.id); setRepoInput(""); setMessage("来源已添加，点击刷新共享目录读取");
    } catch (reason) { fail(reason); }
  }
  const categories = useMemo(() => Array.from(new Set([...local, ...shared.map(item => item.record)].map(item => item.category))).sort(), [local, shared]);
  function matches(item: SkillRecord) { return (category === "全部分类" || item.category === category) && `${item.title} ${item.name} ${item.description} ${item.author}`.toLowerCase().includes(query.trim().toLowerCase()); }
  const localItems = filter === "共享目录" ? [] : local.filter(matches);
  const sharedItems = filter === "本机上传" ? [] : shared.filter(item => matches(item.record));
  function metadata(item: SkillRecord, origin: string) {
    return <><div className="skill-card-heading"><span className="skill-mark" aria-hidden="true">SK</span><div><h2>{item.title}</h2><span className="skill-code">{item.name}</span></div></div><p>{item.description}</p><div className="skill-tags"><span>v{item.version}</span><span>{item.category}</span><span>{item.fileCount} 个文件 · {displaySize(item.size)}</span></div><small className="skill-origin">{item.author || "未填写作者"} · {origin}</small></>;
  }
  return <section className="skill-library productivity-view">
    <header className="productivity-head"><div><span>SKILL LIBRARY</span><h1>Skill 中心</h1><p>下载团队工作流，上传自己的 Skill，并发布到共享目录。</p></div><button className="ghost" onClick={onBack}>← 返回工具台</button></header>
    <div className="skill-toolbar">
      <button className="primary" disabled={!!busy} onClick={() => fileInput.current?.click()}>＋ 上传 Skill</button>
      <input ref={fileInput} type="file" accept=".zip,.md" hidden onChange={event => void upload(event.target.files?.[0])} aria-label="选择 Skill 包" />
      <button className="ghost" disabled={!!busy} onClick={() => void refresh()}>{busy === "refresh" ? "正在刷新…" : "刷新共享目录"}</button>
      <button className="ghost" onClick={() => setShowSources(value => !value)} aria-expanded={showSources}>目录来源</button>
      <span>ZIP 或 SKILL.md · 最大 5 MB · 上传后先保存在本机</span>
    </div>
    {message && <div className="skill-notice" role="status">{message}</div>}
    {error && <div className="skill-error" role="alert">{error}</div>}
    {showSources && <section className="skill-panel" aria-label="目录来源设置">
      <h2>GitHub 共享来源</h2><p>目录位于仓库的 public/skills/catalog.json。添加其他团队仓库即可扩展。</p>
      <div className="skill-source-list">{sources.map(item => <div key={item.id}><label><input type="radio" name="skill-source" checked={source.id === item.id} onChange={() => setSourceId(item.id)} />{item.repository}<small>{item.branch}</small></label><a href={`https://github.com/${item.repository}`} target="_blank" rel="noopener noreferrer">查看仓库 ↗</a>{sources.length > 1 && <button className="skill-text-button" onClick={() => { const next = sources.filter(value => value.id !== item.id); rememberSources(next); if (sourceId === item.id) setSourceId(next[0].id); setShared(values => values.filter(value => value.source.id !== item.id)); }}>移除来源</button>}</div>)}</div>
      <form onSubmit={addSource} className="skill-source-form"><label>公开仓库<input required value={repoInput} onChange={event => setRepoInput(event.target.value)} placeholder="owner/repository" maxLength={160} /></label><label>分支<input required value={branchInput} onChange={event => setBranchInput(event.target.value)} maxLength={160} /></label><button className="ghost" type="submit">添加来源</button></form>
    </section>}
    {draft && <form className="skill-panel skill-upload-form" onSubmit={event => void saveDraft(event)}>
      <h2>核对上传信息</h2><div className="skill-form-grid">
        <label>显示名称<input required value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>目录版本<input required readOnly={draft.declaredVersion} value={draft.version} onChange={event => setDraft({ ...draft, version: event.target.value })} /><small>{draft.declaredVersion ? "版本来自包内，升级请修改包内版本后重新上传" : "包内未声明版本，可为目录指定版本"}</small></label>
        <label>分类<input required value={draft.category} maxLength={60} list="skill-categories" onChange={event => setDraft({ ...draft, category: event.target.value })} /></label>
        <label>作者<input value={draft.author} maxLength={120} onChange={event => setDraft({ ...draft, author: event.target.value })} placeholder="团队或作者名称" /></label>
        <label className="skill-form-wide">简介<textarea required value={draft.description} maxLength={1024} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      </div><datalist id="skill-categories">{["需求分析", "文档处理", "评审", "开发", "其他", ...categories].filter((value, index, all) => all.indexOf(value) === index).map(value => <option key={value} value={value} />)}</datalist>
      <div className="skill-toolbar"><button className="primary" type="submit" disabled={!!busy}>保存到本机</button><button className="ghost" type="button" disabled={!!busy} onClick={() => setDraft(null)}>取消</button><span>{draft.fileCount} 个文件 · {displaySize(draft.size)} · {draft.name}</span></div>
    </form>}
    <div className="skill-filters"><label>查找 Skill<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、简介或作者" /></label><label>位置<select value={filter} onChange={event => setFilter(event.target.value)}><option>全部</option><option>共享目录</option><option>本机上传</option></select></label><label>分类<select value={category} onChange={event => setCategory(event.target.value)}><option>全部分类</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
    <div className="skill-grid">
      {sharedItems.map(item => <article className="skill-card" key={item.source.id + item.record.id}>{metadata(item.record, item.bundled ? "随工具提供" : item.source.repository)}<div className="skill-actions"><button className="primary" disabled={!!busy} onClick={() => void sharedAction(item, "download")}>下载 ZIP</button><button className="ghost" disabled={!!busy} onClick={() => void sharedAction(item, "preview")}>查看说明</button><a href={`https://github.com/${item.source.repository}/blob/${encodeURIComponent(item.source.branch)}/${item.record.packagePath}`} target="_blank" rel="noopener noreferrer">GitHub ↗</a></div></article>)}
      {localItems.map(skill => <article className="skill-card" key={"local:" + skill.id}>{metadata(skill, "本机上传")}<div className="skill-actions"><button className="primary" onClick={() => download(skill.blob, `${skill.name}-v${skill.version}.zip`)}>下载 ZIP</button><button className="ghost" onClick={() => { setPreviewTab("SKILL.md"); setPreview(skill); }}>查看说明</button><button className="ghost" disabled={!!busy} onClick={() => { resetNotice(); setToken(""); setPublishing(skill); }}>发布到共享目录</button><button className="skill-text-button" disabled={!!busy} onClick={() => void remove(skill)}>移除</button></div></article>)}
    </div>
    {!localItems.length && !sharedItems.length && <div className="skill-empty"><h2>{query || category !== "全部分类" ? "没有找到匹配的 Skill" : "还没有 Skill"}</h2><p>上传自己的 Skill，或选择来源后刷新共享目录。</p></div>}
    <p className="skill-footnote">普通文档处理保持本地运行。只有刷新、下载远程包或发布时访问 GitHub；查看 Skill 不会执行包内脚本。</p>
    <dialog ref={previewDialog} className="skill-dialog" onCancel={() => setPreview(null)} onClose={() => setPreview(null)}>
      {preview && <><header><div><h2>{preview.title}</h2><small>v{preview.version} · {preview.fileCount} 个文件</small></div><button className="ghost" onClick={() => { previewDialog.current?.close(); setPreview(null); }}>关闭</button></header><nav aria-label="预览文件">{["SKILL.md", "README.md", "SOP.md", "文件清单"].map(tab => <button key={tab} className={previewTab === tab ? "primary" : "ghost"} aria-pressed={previewTab === tab} onClick={() => setPreviewTab(tab)}>{tab}</button>)}</nav><pre>{previewTab === "SKILL.md" ? preview.skillText : previewTab === "README.md" ? preview.readmeText || "包内未提供 README.md" : previewTab === "SOP.md" ? preview.sopText || "包内未提供 SOP.md" : preview.files.join("\n")}</pre></>}
    </dialog>
    <dialog ref={publishDialog} className="skill-dialog skill-publish-dialog" onCancel={event => { if (busy === "publish") event.preventDefault(); else closePublish(); }}>
      {publishing && <form onSubmit={event => void publish(event)}><header><h2>发布到共享目录</h2><button type="button" className="ghost" disabled={busy === "publish"} onClick={closePublish}>关闭</button></header>
        <p><strong>{publishing.title}</strong> · v{publishing.version} · {displaySize(publishing.size)}</p>
        <label>目标仓库<select value={source.id} disabled={busy === "publish"} onChange={event => { setToken(""); setSourceId(event.target.value); }}>{sources.map(item => <option key={item.id} value={item.id}>{item.repository} · {item.branch}</option>)}</select></label>
        <p>{repository ? (repository.private ? "该仓库为私有仓库，当前版本仅支持公开共享目录。" : "这是公开仓库。发布后，其他人可以下载这个 Skill 包及其中全部文件。") : "正在核对仓库信息…"}</p>
        <label>GitHub 访问令牌<input type="password" required autoComplete="off" value={token} disabled={busy === "publish"} onChange={event => setToken(event.target.value)} placeholder="需要此仓库的 Contents 写权限" /></label><small>令牌只保留在本次页面内存，发布完成或关闭后清除。没有写权限时，可先下载 ZIP，交给仓库维护人发布。</small>
        {error && <div className="skill-error" role="alert">{error}</div>}
        <div className="skill-toolbar"><button className="primary" type="submit" disabled={!repository || repository.private || busy === "publish" || !token.trim()}>{busy === "publish" ? "正在发布…" : "发布到公开仓库"}</button></div>
      </form>}
    </dialog>
  </section>;
}
