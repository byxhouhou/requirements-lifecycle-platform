"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import "./workflow.css";
import "./input-overrides.css";
import "./compare.css";
import { compareSnapshots, DiffRow, SnapshotFile, snapshotDocuments } from "./diff-utils";

type ImportedDoc = {
  id: string;
  file: File;
  name: string;
  path: string;
  size: number;
  format: "WORD" | "WPS" | "PDF";
};

type BaselineCommit = {
  id: string;
  version: string;
  date: string;
  type: string;
  note: string;
  author: string;
  archive: string;
  fileCount: number;
  createdAt: string;
  snapshots?: SnapshotFile[];
};

type WritableFile = { write: (data: string | Blob) => Promise<void>; close: () => Promise<void> };
type FileHandle = { createWritable: () => Promise<WritableFile> };
type DirectoryHandle = {
  name: string;
  getDirectoryHandle: (name: string, options: { create: boolean }) => Promise<DirectoryHandle>;
  getFileHandle: (name: string, options: { create: boolean }) => Promise<FileHandle>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
  }
}

const STORAGE_KEY = "reqflow-baseline-history-v1";

const readBrowserHistory = (): BaselineCommit[] => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
};

const loadPersistedHistory = async (): Promise<BaselineCommit[]> => {
  const browserHistory = readBrowserHistory();
  try {
    const response = await fetch("/api/state", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return browserHistory;
    }
    const payload = await response.json() as { history?: BaselineCommit[] };
    return Array.isArray(payload.history) ? payload.history : browserHistory;
  } catch {
    return browserHistory;
  }
};

const persistHistory = (history: BaselineCommit[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  void fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, history }),
  }).catch(() => {
    // Development mode has no local EXE persistence API; browser storage remains available.
  });
};

const readableSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const today = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

const safeName = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();

const writeFile = async (folder: DirectoryHandle, name: string, data: string | Blob) => {
  const file = await folder.getFileHandle(safeName(name), { create: true });
  const writer = await file.createWritable();
  await writer.write(data);
  await writer.close();
};

export default function Home() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<ImportedDoc[]>([]);
  const [sourceFolder, setSourceFolder] = useState("");
  const [archiveHandle, setArchiveHandle] = useState<DirectoryHandle | null>(null);
  const [archiveName, setArchiveName] = useState("");
  const [history, setHistory] = useState<BaselineCommit[]>([]);
  const [version, setVersion] = useState(`BL-${today().replaceAll("-", ".")}-r1`);
  const [commitDate, setCommitDate] = useState(today());
  const [changeType, setChangeType] = useState("建立基线");
  const [author, setAuthor] = useState("林产品");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [toast, setToast] = useState("");
  const [baseVersionId, setBaseVersionId] = useState("");
  const [targetVersionId, setTargetVersionId] = useState("");
  const [diffRows, setDiffRows] = useState<DiffRow[]>([]);
  const [diffStats, setDiffStats] = useState({ changed: 0, added: 0, deleted: 0, same: 0 });
  const [deleteTarget, setDeleteTarget] = useState<BaselineCommit | null>(null);
  const [editTarget, setEditTarget] = useState<BaselineCommit | null>(null);
  const [editType, setEditType] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editConfirming, setEditConfirming] = useState(false);

  useEffect(() => {
    void loadPersistedHistory().then(setHistory);
  }, []);

  useEffect(() => {
    const next = history.length + 1;
    setVersion(`BL-${today().replaceAll("-", ".")}-r${next}`);
  }, [history.length]);

  const totalSize = useMemo(() => documents.reduce((sum, doc) => sum + doc.size, 0), [documents]);
  const comparableVersions = useMemo(() => history.filter(item => item.snapshots?.length), [history]);
  useEffect(() => {
    if (!comparableVersions.length) return;
    if (!targetVersionId || !comparableVersions.some(item => item.id === targetVersionId)) {
      setTargetVersionId(comparableVersions[0].id);
    }
    if (!baseVersionId || !comparableVersions.some(item => item.id === baseVersionId)) {
      setBaseVersionId(comparableVersions[1]?.id ?? comparableVersions[0].id);
    }
  }, [comparableVersions, baseVersionId, targetVersionId]);
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2300);
  };

  const importDocuments = (event: ChangeEvent<HTMLInputElement>, mode: "folder" | "files") => {
    const supported = Array.from(event.target.files ?? []).filter(file => /\.(doc|docx|wps|pdf)$/i.test(file.name));
    const mapped: ImportedDoc[] = supported.map(file => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const format = extension === "pdf" ? "PDF" : extension === "wps" ? "WPS" : "WORD";
      const path = file.webkitRelativePath || file.name;
      return { id: `${file.name}-${file.size}-${file.lastModified}`, file, name: file.name, path, size: file.size, format };
    });
    if (mode === "folder") {
      setDocuments(mapped);
      setSourceFolder(mapped[0]?.path.split("/")[0] ?? "");
    } else {
      setDocuments(current => {
        const combined = [...current, ...mapped];
        return combined.filter((doc, index) => combined.findIndex(item => item.id === doc.id) === index);
      });
      setSourceFolder(current => current && current !== "手动选择的文件" ? `${current} + 手动选择` : "手动选择的文件");
    }
    notify(mapped.length
      ? mode === "folder" ? `已从文件夹识别 ${mapped.length} 份需求文档` : `已添加 ${mapped.length} 份需求文档`
      : "未发现受支持的 Word、WPS 或 PDF 文档");
    event.target.value = "";
  };

  const chooseArchive = async () => {
    if (!window.showDirectoryPicker) {
      notify("当前浏览器不支持写入文件夹，请使用最新版 Chrome 或 Edge");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      setArchiveHandle(handle);
      setArchiveName(handle.name);
      notify(`归档目录已设为：${handle.name}`);
    } catch {
      notify("未更改归档目录");
    }
  };

  const removeDoc = (id: string) => {
    setDocuments(items => items.filter(item => item.id !== id));
  };

  const createBaseline = async () => {
    if (!documents.length) return notify("请先选择需求输入文件夹");
    if (!archiveHandle) return notify("请先设置归档文件夹");
    if (!version.trim()) return notify("请填写基线版本号");

    setWorking(true);
    try {
      const commitId = Math.abs(documents.reduce((hash, doc) =>
        ((hash << 5) - hash + doc.name.length + doc.size + doc.file.lastModified) | 0, Date.now() & 0xfffffff))
        .toString(16).slice(0, 7).padStart(7, "0");
      const snapshots = await snapshotDocuments(documents);
      const commit: BaselineCommit = {
        id: commitId,
        version: version.trim(),
        date: commitDate,
        type: changeType,
        note: note.trim() || "无补充说明",
        author: author.trim() || "未署名",
        archive: archiveHandle.name,
        fileCount: documents.length,
        createdAt: new Date().toISOString(),
        snapshots,
      };
      const projectFolder = await archiveHandle.getDirectoryHandle("系统需求基线", { create: true });
      const versionFolder = await projectFolder.getDirectoryHandle(safeName(`${commitDate}_${version}_${commitId}`), { create: true });
      const filesFolder = await versionFolder.getDirectoryHandle("source-documents", { create: true });

      for (const [index, doc] of documents.entries()) {
        await writeFile(filesFolder, `${String(index + 1).padStart(2, "0")}_${doc.name}`, doc.file);
      }

      const manifest = {
        schema: "reqflow-baseline/v1",
        ...commit,
        sourceFolder,
        documents: documents.map(doc => ({
          name: doc.name,
          relativePath: doc.path,
          format: doc.format,
          size: doc.size,
          lastModified: new Date(doc.file.lastModified).toISOString(),
        })),
      };
      const baseline = [
        `# 系统需求基线 ${commit.version}`,
        "",
        `- 提交编号：${commit.id}`,
        `- 基线日期：${commit.date}`,
        `- 变更类型：${commit.type}`,
        `- 提交人：${commit.author}`,
        `- 来源文件夹：${sourceFolder}`,
        `- 归档文件夹：${commit.archive}`,
        `- 备注：${commit.note}`,
        "",
        "## 输入文档清单",
        "",
        ...documents.map((doc, index) => `${index + 1}. ${doc.name}（${doc.format}，${readableSize(doc.size)}）`),
        "",
        "> 本文件由 ReqFlow 自动生成，与 manifest.json 及 source-documents 共同构成本次基线。",
      ].join("\n");
      await writeFile(versionFolder, "baseline-requirements.md", baseline);
      await writeFile(versionFolder, "manifest.json", JSON.stringify(manifest, null, 2));

      const nextHistory = [commit, ...history];
      const changelog = [
        "# 系统需求基线变更记录",
        "",
        ...nextHistory.map(item =>
          `## ${item.version} · ${item.id}\n\n- 日期：${item.date}\n- 类型：${item.type}\n- 提交人：${item.author}\n- 文档：${item.fileCount} 份\n- 备注：${item.note}\n`
        ),
      ].join("\n");
      await writeFile(projectFolder, "CHANGELOG.md", changelog);
      setHistory(nextHistory);
      persistHistory(nextHistory);
      setNote("");
      notify(`${commit.version} 已建立并写入归档文件夹`);
    } catch (error) {
      console.error(error);
      notify("归档写入失败，请确认文件夹写入权限");
    } finally {
      setWorking(false);
    }
  };

  const runComparison = () => {
    if (!baseVersionId || !targetVersionId) return notify("请选择两个基线版本");
    if (baseVersionId === targetVersionId) return notify("请选择两个不同的基线版本");
    const base = history.find(item => item.id === baseVersionId);
    const target = history.find(item => item.id === targetVersionId);
    if (!base?.snapshots?.length || !target?.snapshots?.length) return notify("所选版本缺少可比较的内容快照");
    const result = compareSnapshots(base.snapshots, target.snapshots);
    setDiffRows(result.rows);
    setDiffStats({ changed: result.changed, added: result.added, deleted: result.deleted, same: result.same });
    notify(`比较完成：发现 ${result.changed + result.added + result.deleted} 处差异`);
  };

  const deleteRecord = () => {
    if (!deleteTarget) return;
    const nextHistory = history.filter(item => item.id !== deleteTarget.id);
    setHistory(nextHistory);
    persistHistory(nextHistory);
    if (baseVersionId === deleteTarget.id) setBaseVersionId("");
    if (targetVersionId === deleteTarget.id) setTargetVersionId("");
    if (baseVersionId === deleteTarget.id || targetVersionId === deleteTarget.id) {
      setDiffRows([]);
      setDiffStats({ changed: 0, added: 0, deleted: 0, same: 0 });
    }
    setDeleteTarget(null);
    notify(`${deleteTarget.version} 的本机记录已删除`);
  };

  const openRecordEditor = (record: BaselineCommit) => {
    setEditTarget(record);
    setEditType(record.type);
    setEditNote(record.note);
    setEditConfirming(false);
  };

  const closeRecordEditor = () => {
    setEditTarget(null);
    setEditType("");
    setEditNote("");
    setEditConfirming(false);
  };

  const reviewRecordEdit = () => {
    if (!editTarget) return;
    if (!editType.trim()) return notify("请选择变更类型");
    if (!editNote.trim()) return notify("请填写归档备注");
    if (editType === editTarget.type && editNote.trim() === editTarget.note) {
      return notify("变更类型和备注均未修改");
    }
    setEditConfirming(true);
  };

  const saveRecordEdit = () => {
    if (!editTarget) return;
    const nextHistory = history.map(item => item.id === editTarget.id
      ? { ...item, type: editType, note: editNote.trim() }
      : item);
    setHistory(nextHistory);
    persistHistory(nextHistory);
    const changedVersion = editTarget.version;
    closeRecordEditor();
    notify(`${changedVersion} 的归档信息已更新`);
  };

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-mark">R</div>
        <button className="rail-btn active" aria-label="需求输入">⇩</button>
        <button className="rail-btn" aria-label="工作流">⌘</button>
        <button className="rail-btn" aria-label="基线记录">▤</button>
        <button className="rail-btn" aria-label="归档管理">▣</button>
        <div className="rail-spacer" />
        <button className="avatar" aria-label="当前用户">林</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">需求工作空间 / Nova 系统平台</div>
            <div className="title-row">
              <h1>需求输入与基线管理</h1>
              <span className="local-badge">● 本地模式</span>
            </div>
          </div>
          <div className="top-actions">
            <button className="ghost" onClick={() => fileInputRef.current?.click()}>选择文件</button>
            <button className="ghost" onClick={() => folderInputRef.current?.click()}>选择文件夹</button>
            <button className="primary" onClick={createBaseline} disabled={working}>
              {working ? "正在归档…" : "提交新基线"}
            </button>
          </div>
        </header>

        <section className="flow-strip" aria-label="基线建立流程">
          <div className={`flow-step ${documents.length ? "complete" : "current"}`}>
            <span>01</span><i>选择文件或文件夹</i><small>支持跨目录组合输入</small>
          </div>
          <b>→</b>
          <div className={`flow-step ${documents.length && !archiveHandle ? "current" : archiveHandle ? "complete" : ""}`}>
            <span>02</span><i>核对文档与信息</i><small>日期 · 类型 · 备注</small>
          </div>
          <b>→</b>
          <div className={`flow-step ${documents.length && archiveHandle ? "current" : ""}`}>
            <span>03</span><i>建立基线并归档</i><small>版本 · 清单 · 变更记录</small>
          </div>
        </section>

        <section className="metrics">
          <div><span>本次输入</span><strong>{documents.length}</strong><small>份有效文档</small></div>
          <div><span>输入容量</span><strong>{readableSize(totalSize)}</strong><small>待归档文件</small></div>
          <div><span>已有基线</span><strong>{history.length}</strong><small>次版本提交</small></div>
          <div><span>当前归档</span><strong className="folder-metric">{archiveName || "尚未设置"}</strong><small>{archiveName ? "可写入" : "请选择文件夹"}</small></div>
        </section>

        <section className="main-grid">
          <div className="main-column">
            <section className="card source-card">
              <div className="card-head">
                <div><span className="section-kicker">SOURCE DOCUMENTS</span><h2>输入文档</h2></div>
                {sourceFolder && <div className="folder-chip">▰ {sourceFolder}</div>}
              </div>

              {!documents.length ? (
                <div className="drop-zone">
                  <span className="drop-icon">⇩</span>
                  <strong>添加需求输入文档</strong>
                  <small>可选择不同目录下的文件，也可一次导入整个文件夹</small>
                  <div className="drop-actions">
                    <button className="drop-primary" onClick={() => fileInputRef.current?.click()}>选择一个或多个文件</button>
                    <button onClick={() => folderInputRef.current?.click()}>选择整个文件夹</button>
                  </div>
                  <em>支持 .doc、.docx、.wps 和 .pdf</em>
                </div>
              ) : (
                <div className="doc-list">
                  {documents.map(doc => (
                    <article className="doc-row" key={doc.id}>
                      <div className={`format-icon ${doc.format.toLowerCase()}`}>{doc.format === "WORD" ? "W" : doc.format === "PDF" ? "P" : "S"}</div>
                      <div className="doc-info"><strong>{doc.name}</strong><small>{doc.path} · {readableSize(doc.size)}</small></div>
                      <span className="ready-dot">● 待归档</span>
                      <button onClick={() => removeDoc(doc.id)} aria-label={`移除 ${doc.name}`}>×</button>
                    </article>
                  ))}
                  <div className="add-more">
                    <button onClick={() => fileInputRef.current?.click()}>＋ 追加文件</button>
                    <button onClick={() => folderInputRef.current?.click()}>↻ 重新选择文件夹</button>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                className="hidden-input"
                type="file"
                multiple
                accept=".doc,.docx,.wps,.pdf"
                onChange={event => importDocuments(event, "files")}
              />
              <input
                ref={folderInputRef}
                className="hidden-input"
                type="file"
                multiple
                accept=".doc,.docx,.wps,.pdf"
                onChange={event => importDocuments(event, "folder")}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
            </section>

            <section className="card compare-card">
              <div className="card-head compare-heading">
                <div>
                  <span className="section-kicker">VERSION DIFF</span>
                  <h2>基线差异对比</h2>
                </div>
                <div className="diff-legend">
                  <span className="legend-added">新增</span>
                  <span className="legend-deleted">删除</span>
                  <span className="legend-changed">修改</span>
                </div>
              </div>

              {comparableVersions.length < 2 ? (
                <div className="compare-empty">
                  <span>⇄</span>
                  <p>至少提交两个新基线后即可进行内容对比</p>
                  <small>新提交的 DOCX 文档会自动保存正文快照；历史旧记录需要重新提交。</small>
                </div>
              ) : (
                <>
                  <div className="compare-controls">
                    <label>
                      <span>基准版本</span>
                      <select value={baseVersionId} onChange={event => setBaseVersionId(event.target.value)}>
                        {comparableVersions.map(item => <option value={item.id} key={`base-${item.id}`}>{item.version} · {item.id}</option>)}
                      </select>
                    </label>
                    <button className="swap-button" onClick={() => {
                      setBaseVersionId(targetVersionId);
                      setTargetVersionId(baseVersionId);
                      setDiffRows([]);
                    }} aria-label="交换比较版本">⇄</button>
                    <label>
                      <span>目标版本</span>
                      <select value={targetVersionId} onChange={event => setTargetVersionId(event.target.value)}>
                        {comparableVersions.map(item => <option value={item.id} key={`target-${item.id}`}>{item.version} · {item.id}</option>)}
                      </select>
                    </label>
                    <button className="compare-button" onClick={runComparison}>开始对比</button>
                  </div>

                  {diffRows.length > 0 ? (
                    <div className="diff-result">
                      <div className="diff-summary">
                        <span><b>{diffStats.changed}</b> 修改</span>
                        <span><b>{diffStats.added}</b> 新增</span>
                        <span><b>{diffStats.deleted}</b> 删除</span>
                        <span><b>{diffStats.same}</b> 相同</span>
                      </div>
                      <div className="diff-pane-head">
                        <strong>{comparableVersions.find(item => item.id === baseVersionId)?.version}</strong>
                        <strong>{comparableVersions.find(item => item.id === targetVersionId)?.version}</strong>
                      </div>
                      <div className="diff-viewport">
                        {diffRows.map((row, index) => (
                          <div className={`diff-row diff-${row.type}`} key={`${index}-${row.leftNumber}-${row.rightNumber}`}>
                            <div className="diff-side">
                              <span className="line-number">{row.leftNumber ?? ""}</span>
                              <code>{row.left || " "}</code>
                            </div>
                            <div className="diff-side">
                              <span className="line-number">{row.rightNumber ?? ""}</span>
                              <code>{row.right || " "}</code>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="compare-ready"><span>⇄</span><p>选择两个版本，查看逐行内容差异</p></div>
                  )}
                </>
              )}
            </section>

            <section className="card history-card">
              <div className="card-head">
                <div><span className="section-kicker">DOCUMENT ARCHIVE</span><h2>文档归档记录</h2></div>
                <span className="history-count">{history.length} 次归档</span>
              </div>
              {!history.length ? (
                <div className="empty-history"><span>⌁</span><p>尚无文档归档记录</p><small>完成首次归档后，记录会显示在这里</small></div>
              ) : (
                <div className="timeline">
                  {history.map((item, index) => (
                    <article className="commit" key={`${item.id}-${index}`}>
                      <div className="commit-line"><i /></div>
                      <div className="commit-main">
                        <div>
                          <strong>{item.version}</strong><code>{item.id}</code><span>{item.type}</span>
                          <button className="edit-record" onClick={() => openRecordEditor(item)} aria-label={`修改 ${item.version} 归档信息`}>修改</button>
                          <button className="delete-record" onClick={() => setDeleteTarget(item)} aria-label={`删除 ${item.version} 记录`}>删除</button>
                        </div>
                        <p>{item.note}</p>
                        <small>{item.date} · {item.author} · {item.fileCount} 份文档 · 归档至 {item.archive}</small>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="commit-panel card">
            <div className="panel-heading">
              <span className="git-mark">⑂</span>
              <div><span className="section-kicker">BASELINE COMMIT</span><h2>提交基线</h2></div>
            </div>

            <label>基线版本号<input value={version} onChange={event => setVersion(event.target.value)} /></label>
            <div className="field-row">
              <label>基线日期<input type="date" value={commitDate} onChange={event => setCommitDate(event.target.value)} /></label>
              <label>变更类型<select value={changeType} onChange={event => setChangeType(event.target.value)}>
                <option>建立基线</option><option>需求新增</option><option>需求变更</option><option>问题修订</option>
              </select></label>
            </div>
            <label>提交人<input value={author} onChange={event => setAuthor(event.target.value)} /></label>
            <label>变更说明 / 备注<textarea placeholder="说明本次输入文档的来源、变更原因或评审结论…" value={note} onChange={event => setNote(event.target.value)} /></label>

            <div className="archive-box">
              <div className="archive-icon">▣</div>
              <div><small>归档文件夹</small><strong>{archiveName || "尚未设置"}</strong><span>{archiveName ? "将生成版本目录、清单与变更记录" : "选择一个本机文件夹用于保存基线"}</span></div>
              <button onClick={chooseArchive}>{archiveName ? "更改" : "设置"}</button>
            </div>

            <div className="commit-summary">
              <div><span>将归档</span><strong>{documents.length} 份文档</strong></div>
              <div><span>生成内容</span><strong>基线文档 + 清单</strong></div>
            </div>

            <button className="commit-button" onClick={createBaseline} disabled={working}>
              <span>⑂</span>{working ? "正在写入归档…" : "建立并提交基线"}
            </button>
            <p className="privacy-note">所有文档仅在本机读取并写入你选择的归档目录，不会上传。</p>
          </aside>
        </section>
      </section>
      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setDeleteTarget(null);
        }}>
          <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <button className="dialog-close" onClick={() => setDeleteTarget(null)} aria-label="关闭">×</button>
            <div className="warning-icon">!</div>
            <h2 id="delete-title">删除文档归档记录？</h2>
            <p>即将删除 <strong>{deleteTarget.version}</strong>（{deleteTarget.id}）的本机归档记录与对比快照。</p>
            <div className="archive-safe-note"><span>▣</span><p><strong>归档文件不会被删除</strong><small>已经写入“{deleteTarget.archive}”的源文档和版本目录仍会保留。</small></p></div>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="danger-button" onClick={deleteRecord}>确认删除记录</button>
            </div>
          </section>
        </div>
      )}
      {editTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) closeRecordEditor();
        }}>
          <section className="delete-dialog edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <button className="dialog-close" onClick={closeRecordEditor} aria-label="关闭">×</button>
            <div className="edit-icon">{editConfirming ? "✓" : "✎"}</div>
            <h2 id="edit-title">{editConfirming ? "确认修改归档信息" : "修改文档归档记录"}</h2>
            <p className="edit-identity">{editTarget.version} · {editTarget.id}</p>

            {!editConfirming ? (
              <>
                <div className="edit-fields">
                  <label>变更类型<select value={editType} onChange={event => setEditType(event.target.value)}>
                    <option>建立基线</option><option>需求新增</option><option>需求变更</option><option>问题修订</option>
                  </select></label>
                  <label>备注<textarea value={editNote} onChange={event => setEditNote(event.target.value)} placeholder="填写本次归档说明…" /></label>
                </div>
                <div className="dialog-actions">
                  <button className="ghost" onClick={closeRecordEditor}>取消</button>
                  <button className="review-button" onClick={reviewRecordEdit}>下一步：确认修改</button>
                </div>
              </>
            ) : (
              <>
                <div className="change-review">
                  <div><span>变更类型</span><del>{editTarget.type}</del><b>→</b><ins>{editType}</ins></div>
                  <div className="note-change"><span>备注</span><del>{editTarget.note}</del><b>→</b><ins>{editNote.trim()}</ins></div>
                </div>
                <p className="confirm-hint">确认后将更新本机归档记录；归档文件夹中的源文档不会改变。</p>
                <div className="dialog-actions">
                  <button className="ghost" onClick={() => setEditConfirming(false)}>返回修改</button>
                  <button className="confirm-edit-button" onClick={saveRecordEdit}>确认保存修改</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}
