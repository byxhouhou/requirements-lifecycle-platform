"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import "./workflow.css";
import "./input-overrides.css";
import "./compare.css";
import "./quick-links.css";
import "./tool-home.css";
import { compareSnapshots, DiffRow, SnapshotFile, snapshotDocuments } from "./diff-utils";

type ImportedDoc = {
  id: string;
  file: File;
  name: string;
  path: string;
  absolutePath?: string;
  size: number;
  format: "WORD" | "WPS" | "PDF";
};

type SourceDocumentPath = {
  name: string;
  path: string;
  relativePath?: string;
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
  sourcePaths?: SourceDocumentPath[];
  beyondComparePath?: string;
};

type ComparisonMethod = "local" | "beyond" | "ai";
type WorkspaceView = "tools" | "compare" | "quick-links";

type BeyondCompareStatus = {
  installed: boolean;
  executablePath: string;
  version: string;
};

type LocalFileDescriptor = {
  token: string;
  name: string;
  path: string;
  relativePath: string;
  size: number;
  lastModified: number;
};

type QuickLink = {
  id: string;
  name: string;
  url: string;
  project: string;
};

type QuickLinkScreen = "list" | "edit";

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
const QUICK_LINKS_STORAGE_KEY = "reqflow-quick-links-v1";
const DEFAULT_QUICK_LINK_PROJECT = "默认项目";

const normalizeQuickLinks = (links: QuickLink[]) => links.map(link => ({
  ...link,
  project: link.project?.trim() || DEFAULT_QUICK_LINK_PROJECT,
}));

const readBrowserHistory = (): BaselineCommit[] => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
};

const readBrowserQuickLinks = (): QuickLink[] => {
  const saved = localStorage.getItem(QUICK_LINKS_STORAGE_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? normalizeQuickLinks(parsed) : [];
  } catch {
    return [];
  }
};

const loadPersistedState = async (): Promise<{ history: BaselineCommit[]; quickLinks: QuickLink[] }> => {
  const browserHistory = readBrowserHistory();
  const browserQuickLinks = readBrowserQuickLinks();
  try {
    const response = await fetch("/api/state", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return { history: browserHistory, quickLinks: browserQuickLinks };
    }
    const payload = await response.json() as { history?: BaselineCommit[]; quickLinks?: QuickLink[] };
    return {
      history: Array.isArray(payload.history) ? payload.history : browserHistory,
      quickLinks: Array.isArray(payload.quickLinks) ? normalizeQuickLinks(payload.quickLinks) : browserQuickLinks,
    };
  } catch {
    return { history: browserHistory, quickLinks: browserQuickLinks };
  }
};

const persistState = (history: BaselineCommit[], quickLinks: QuickLink[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  localStorage.setItem(QUICK_LINKS_STORAGE_KEY, JSON.stringify(quickLinks));
  void fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 3, history, quickLinks }),
  }).catch(() => {
    // Development mode has no local EXE persistence API; browser storage remains available.
  });
};

const normalizeQuickLink = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || /^(javascript|data|vbscript):/i.test(trimmed)) return "";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

const parseQuickLinkConfig = (content: string): QuickLink[] => {
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/s, "$1").replace(/""/g, "\"");
  return content.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const delimiter = ["\t", ",", "，", ";"].find(item => trimmed.includes(item));
    if (!delimiter) return [];
    const fields = trimmed.split(delimiter).map(unquote);
    const hasProject = fields.length >= 3;
    const project = hasProject ? fields[0] : DEFAULT_QUICK_LINK_PROJECT;
    const name = hasProject ? fields[1] : fields[0];
    const rawUrl = hasProject ? fields.slice(2).join(delimiter) : fields.slice(1).join(delimiter);
    if (index === 0 && /^(项目名称|项目|project)$/i.test(project) && /^(按钮名称|名称|name)$/i.test(name)) return [];
    if (index === 0 && !hasProject && /^(按钮名称|名称|name)$/i.test(name) && /^(链接地址|链接|url|address)$/i.test(rawUrl)) return [];
    const url = normalizeQuickLink(rawUrl);
    return name && url ? [{ id: crypto.randomUUID(), project: project || DEFAULT_QUICK_LINK_PROJECT, name, url }] : [];
  });
};

const decodeChineseConfig = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = bytes.slice(2);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  const evenNulls = sample.filter((value, index) => index % 2 === 0 && value === 0).length;
  const oddNulls = sample.filter((value, index) => index % 2 === 1 && value === 0).length;
  if (oddNulls > sample.length / 8) return new TextDecoder("utf-16le").decode(bytes);
  if (evenNulls > sample.length / 8) {
    const swapped = bytes.slice();
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // GB18030 is backward compatible with the common GBK and GB2312 encodings.
    return new TextDecoder("gb18030").decode(bytes);
  }
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

const preferredSourcePath = (record?: BaselineCommit) => record?.sourcePaths?.[0]?.path ?? "";
const boundComparisonPath = (record?: BaselineCommit) =>
  record?.beyondComparePath?.trim() || preferredSourcePath(record);

const writeFile = async (folder: DirectoryHandle, name: string, data: string | Blob) => {
  const file = await folder.getFileHandle(safeName(name), { create: true });
  const writer = await file.createWritable();
  await writer.write(data);
  await writer.close();
};

const renderDiffText = (
  segments: DiffRow["leftSegments"] | DiffRow["rightSegments"],
  fallback: string,
  side: "left" | "right",
) => {
  if (!segments?.length) return fallback || " ";
  return segments.map((segment, index) => segment.changed
    ? <mark className={`inline-${side}`} key={`${index}-${segment.text}`}>{segment.text}</mark>
    : <span key={`${index}-${segment.text}`}>{segment.text}</span>);
};

export default function Home() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickLinkFileInputRef = useRef<HTMLInputElement>(null);
  const quickLinksRef = useRef<HTMLElement>(null);
  const diffViewportRef = useRef<HTMLDivElement>(null);
  const [documents, setDocuments] = useState<ImportedDoc[]>([]);
  const [sourceFolder, setSourceFolder] = useState("");
  const [archiveHandle, setArchiveHandle] = useState<DirectoryHandle | null>(null);
  const [archiveName, setArchiveName] = useState("");
  const [history, setHistory] = useState<BaselineCommit[]>([]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("tools");
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [quickLinkScreen, setQuickLinkScreen] = useState<QuickLinkScreen>("list");
  const [quickLinkProject, setQuickLinkProject] = useState(DEFAULT_QUICK_LINK_PROJECT);
  const [quickLinkName, setQuickLinkName] = useState("");
  const [quickLinkUrl, setQuickLinkUrl] = useState("");
  const [editingQuickLinkId, setEditingQuickLinkId] = useState("");
  const [editingQuickLinkProject, setEditingQuickLinkProject] = useState("");
  const [editingQuickLinkName, setEditingQuickLinkName] = useState("");
  const [editingQuickLinkUrl, setEditingQuickLinkUrl] = useState("");
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
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [comparisonMethod, setComparisonMethod] = useState<ComparisonMethod>("local");
  const [compareFullscreen, setCompareFullscreen] = useState(false);
  const [showDifferencesOnly, setShowDifferencesOnly] = useState(false);
  const [activeDiffId, setActiveDiffId] = useState("");
  const [beyondStatus, setBeyondStatus] = useState<BeyondCompareStatus | null>(null);
  const [beyondExecutable, setBeyondExecutable] = useState("");
  const [beyondLeftPath, setBeyondLeftPath] = useState("");
  const [beyondRightPath, setBeyondRightPath] = useState("");
  const [beyondLeftVersionId, setBeyondLeftVersionId] = useState("");
  const [beyondRightVersionId, setBeyondRightVersionId] = useState("");
  const [beyondPicking, setBeyondPicking] = useState(false);
  const [selectingDocuments, setSelectingDocuments] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BaselineCommit | null>(null);
  const [editTarget, setEditTarget] = useState<BaselineCommit | null>(null);
  const [editType, setEditType] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editConfirming, setEditConfirming] = useState(false);

  useEffect(() => {
    void loadPersistedState().then(state => {
      setHistory(state.history);
      setQuickLinks(state.quickLinks);
    });
  }, []);

  useEffect(() => {
    const next = history.length + 1;
    setVersion(`BL-${today().replaceAll("-", ".")}-r${next}`);
  }, [history.length]);

  useEffect(() => {
    if (!compareFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompareFullscreen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [compareFullscreen]);

  useEffect(() => {
    if (comparisonMethod !== "beyond" || beyondStatus) return;
    void fetch("/api/integrations/beyond-compare/status", {
      headers: { Accept: "application/json" },
    }).then(async response => {
      if (!response.ok) throw new Error("status_unavailable");
      const status = await response.json() as BeyondCompareStatus;
      setBeyondStatus(status);
      if (status.executablePath) setBeyondExecutable(status.executablePath);
    }).catch(() => {
      setBeyondStatus({ installed: false, executablePath: "", version: "" });
    });
  }, [comparisonMethod, beyondStatus]);

  const totalSize = useMemo(() => documents.reduce((sum, doc) => sum + doc.size, 0), [documents]);
  const groupedQuickLinks = useMemo(() => {
    const groups = new Map<string, QuickLink[]>();
    quickLinks.forEach(link => {
      const project = link.project?.trim() || DEFAULT_QUICK_LINK_PROJECT;
      groups.set(project, [...(groups.get(project) ?? []), link]);
    });
    return Array.from(groups.entries()).map(([project, links]) => ({ project, links }));
  }, [quickLinks]);
  const comparableVersions = useMemo(() => history.filter(item => item.snapshots?.length), [history]);
  const selectedBaseVersion = useMemo(
    () => history.find(item => item.id === baseVersionId),
    [history, baseVersionId],
  );
  const selectedTargetVersion = useMemo(
    () => history.find(item => item.id === targetVersionId),
    [history, targetVersionId],
  );
  const differenceRows = useMemo(
    () => diffRows.filter(row => row.type !== "file" && row.type !== "same"),
    [diffRows],
  );
  const visibleDiffRows = useMemo(() => {
    if (!showDifferencesOnly) return diffRows;
    const changedFiles = new Set(differenceRows.map(row => row.fileKey));
    return diffRows.filter(row =>
      row.type === "file" ? changedFiles.has(row.fileKey) : row.type !== "same");
  }, [diffRows, differenceRows, showDifferencesOnly]);
  useEffect(() => {
    if (!comparableVersions.length) return;
    if (!targetVersionId || !comparableVersions.some(item => item.id === targetVersionId)) {
      setTargetVersionId(comparableVersions[0].id);
    }
    if (!baseVersionId || !comparableVersions.some(item => item.id === baseVersionId)) {
      setBaseVersionId(comparableVersions[1]?.id ?? comparableVersions[0].id);
    }
  }, [comparableVersions, baseVersionId, targetVersionId]);

  useEffect(() => {
    if (comparisonMethod !== "beyond") return;
    if (beyondLeftVersionId !== baseVersionId) {
      setBeyondLeftPath(boundComparisonPath(history.find(item => item.id === baseVersionId)));
      setBeyondLeftVersionId(baseVersionId);
    }
    if (beyondRightVersionId !== targetVersionId) {
      setBeyondRightPath(boundComparisonPath(history.find(item => item.id === targetVersionId)));
      setBeyondRightVersionId(targetVersionId);
    }
  }, [
    comparisonMethod,
    history,
    baseVersionId,
    targetVersionId,
    beyondLeftVersionId,
    beyondRightVersionId,
  ]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2300);
  };

  const persistComparisonBindings = (bindings: Array<{ versionId: string; path: string }>) => {
    const bindingMap = new Map(bindings
      .filter(binding => binding.versionId && binding.path.trim())
      .map(binding => [binding.versionId, binding.path.trim()]));
    if (!bindingMap.size) return;
    const nextHistory = history.map(item => {
      const path = bindingMap.get(item.id);
      return path ? { ...item, beyondComparePath: path } : item;
    });
    setHistory(nextHistory);
    persistState(nextHistory, quickLinks);
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

  const chooseDocuments = async (mode: "folder" | "files") => {
    const isPackagedRuntime = window.location.port === "37651"
      && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
    if (!isPackagedRuntime) {
      if (mode === "folder") folderInputRef.current?.click();
      else fileInputRef.current?.click();
      return;
    }

    setSelectingDocuments(true);
    try {
      const response = await fetch("/api/local-files/pick", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReqFlow-Integration": "local-files",
        },
        body: JSON.stringify({ kind: mode }),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("native_picker_unavailable");
      }
      const payload = await response.json() as {
        selected?: boolean;
        rootName?: string;
        files?: LocalFileDescriptor[];
      };
      if (!payload.selected) return;
      const descriptors = payload.files ?? [];
      if (!descriptors.length) {
        notify("所选位置没有受支持的 Word、WPS 或 PDF 文档");
        return;
      }

      const mapped = await Promise.all(descriptors.map(async descriptor => {
        const fileResponse = await fetch(`/api/local-files/read/${encodeURIComponent(descriptor.token)}`);
        if (!fileResponse.ok) throw new Error("local_file_read_failed");
        const fileBlob = await fileResponse.blob();
        const file = new File([fileBlob], descriptor.name, {
          type: fileBlob.type,
          lastModified: descriptor.lastModified,
        });
        const extension = descriptor.name.split(".").pop()?.toLowerCase();
        const format = extension === "pdf" ? "PDF" : extension === "wps" ? "WPS" : "WORD";
        return {
          id: `${descriptor.path}-${descriptor.size}-${descriptor.lastModified}`,
          file,
          name: descriptor.name,
          path: descriptor.relativePath || descriptor.name,
          absolutePath: descriptor.path,
          size: descriptor.size,
          format,
        } satisfies ImportedDoc;
      }));

      if (mode === "folder") {
        setDocuments(mapped);
        setSourceFolder(payload.rootName || mapped[0]?.path.split("/")[0] || "");
      } else {
        setDocuments(current => {
          const combined = [...current, ...mapped];
          return combined.filter((doc, index) => combined.findIndex(item => item.id === doc.id) === index);
        });
        setSourceFolder(current => current ? `${current} + 手动选择` : "手动选择的文件");
      }
      notify(mode === "folder"
        ? `已从文件夹识别 ${mapped.length} 份需求文档，并记录原始路径`
        : `已添加 ${mapped.length} 份需求文档，并记录原始路径`);
    } catch {
      notify("本机文件选择器暂不可用，请重启 ReqFlow.exe 后重试");
    } finally {
      setSelectingDocuments(false);
    }
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
      const sourcePaths = documents
        .filter(doc => Boolean(doc.absolutePath))
        .map(doc => ({
          name: doc.name,
          path: doc.absolutePath as string,
          relativePath: doc.path,
        }));
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
        sourcePaths,
      };
      const projectFolder = await archiveHandle.getDirectoryHandle("系统需求基线", { create: true });
      const versionFolder = await projectFolder.getDirectoryHandle(safeName(`${commitDate}_${version}_${commitId}`), { create: true });
      const filesFolder = await versionFolder.getDirectoryHandle("source-documents", { create: true });

      for (const [index, doc] of documents.entries()) {
        await writeFile(filesFolder, `${String(index + 1).padStart(2, "0")}_${doc.name}`, doc.file);
      }

      const archivableCommit: BaselineCommit = { ...commit };
      delete archivableCommit.sourcePaths;
      delete archivableCommit.beyondComparePath;
      const manifest = {
        schema: "reqflow-baseline/v1",
        ...archivableCommit,
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
      persistState(nextHistory, quickLinks);
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
    const result = compareSnapshots(base.snapshots, target.snapshots, {
      ignoreWhitespace,
      algorithm: "balanced",
    });
    setDiffRows(result.rows);
    setDiffStats({ changed: result.changed, added: result.added, deleted: result.deleted, same: result.same });
    setActiveDiffId(result.rows.find(row => row.type !== "file" && row.type !== "same")?.id ?? "");
    notify(`比较完成：发现 ${result.changed + result.added + result.deleted} 处差异`);
  };

  const jumpToDifference = (direction: -1 | 1) => {
    if (!differenceRows.length) return notify("当前两个版本没有差异");
    const current = differenceRows.findIndex(row => row.id === activeDiffId);
    const nextIndex = current < 0
      ? direction > 0 ? 0 : differenceRows.length - 1
      : (current + direction + differenceRows.length) % differenceRows.length;
    const nextId = differenceRows[nextIndex].id;
    setActiveDiffId(nextId);
    window.requestAnimationFrame(() => {
      const target = diffViewportRef.current?.querySelector<HTMLElement>(`[data-diff-id="${nextId}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const pickBeyondComparePath = async (
    kind: "program" | "document",
    apply: (path: string) => void,
  ) => {
    setBeyondPicking(true);
    try {
      const response = await fetch("/api/integrations/beyond-compare/pick", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReqFlow-Integration": "beyond-compare",
        },
        body: JSON.stringify({ kind }),
      });
      const payload = await response.json() as { selected?: boolean; path?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "picker_failed");
      if (payload.selected && payload.path) apply(payload.path);
    } catch {
      notify("本机文件选择不可用，请直接粘贴完整路径");
    } finally {
      setBeyondPicking(false);
    }
  };

  const launchBeyondCompare = async () => {
    const leftPath = beyondLeftPath.trim() || boundComparisonPath(selectedBaseVersion);
    const rightPath = beyondRightPath.trim() || boundComparisonPath(selectedTargetVersion);
    if (!leftPath || !rightPath) return notify("所选版本没有保存文档路径，请先选择对应文件");
    setBeyondLeftPath(leftPath);
    setBeyondRightPath(rightPath);
    persistComparisonBindings([
      { versionId: baseVersionId, path: leftPath },
      { versionId: targetVersionId, path: rightPath },
    ]);

    try {
      let executablePath = beyondExecutable.trim();
      if (!executablePath) {
        const statusResponse = await fetch("/api/integrations/beyond-compare/status", {
          headers: { Accept: "application/json" },
        });
        if (!statusResponse.ok) throw new Error("beyond_status_unavailable");
        const status = await statusResponse.json() as BeyondCompareStatus;
        if (!status.installed || !status.executablePath) throw new Error("beyond_not_installed");
        executablePath = status.executablePath;
        setBeyondStatus(status);
        setBeyondExecutable(executablePath);
      }
      const response = await fetch("/api/integrations/beyond-compare/launch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReqFlow-Integration": "beyond-compare",
        },
        body: JSON.stringify({
          executablePath,
          leftPath,
          rightPath,
        }),
      });
      const payload = await response.json() as { launched?: boolean; error?: string };
      if (!response.ok || !payload.launched) throw new Error(payload.error || "launch_failed");
      notify("Beyond Compare 已打开");
    } catch (error) {
      console.error(error);
      notify("启动失败，请检查程序和文档路径");
    }
  };

  const deleteRecord = () => {
    if (!deleteTarget) return;
    const nextHistory = history.filter(item => item.id !== deleteTarget.id);
    setHistory(nextHistory);
    persistState(nextHistory, quickLinks);
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
    persistState(nextHistory, quickLinks);
    const changedVersion = editTarget.version;
    closeRecordEditor();
    notify(`${changedVersion} 的归档信息已更新`);
  };

  const saveQuickLinks = (nextLinks: QuickLink[]) => {
    setQuickLinks(nextLinks);
    persistState(history, nextLinks);
  };

  const addQuickLink = () => {
    const project = quickLinkProject.trim() || DEFAULT_QUICK_LINK_PROJECT;
    const name = quickLinkName.trim();
    const url = normalizeQuickLink(quickLinkUrl);
    if (!name) return notify("请填写按钮名称");
    if (!url) return notify("请输入有效的 HTTP 或 HTTPS 链接");
    saveQuickLinks([...quickLinks, { id: crypto.randomUUID(), project, name, url }]);
    setQuickLinkName("");
    setQuickLinkUrl("");
    notify(`“${project}”项目已添加快捷按钮“${name}”`);
  };

  const openQuickLinkEditor = (link: QuickLink) => {
    setEditingQuickLinkId(link.id);
    setEditingQuickLinkProject(link.project || DEFAULT_QUICK_LINK_PROJECT);
    setEditingQuickLinkName(link.name);
    setEditingQuickLinkUrl(link.url);
    setQuickLinkScreen("edit");
  };

  const closeQuickLinkEditor = () => {
    setEditingQuickLinkId("");
    setEditingQuickLinkProject("");
    setEditingQuickLinkName("");
    setEditingQuickLinkUrl("");
    setQuickLinkScreen("list");
  };

  const saveQuickLinkEdit = () => {
    const project = editingQuickLinkProject.trim() || DEFAULT_QUICK_LINK_PROJECT;
    const name = editingQuickLinkName.trim();
    const url = normalizeQuickLink(editingQuickLinkUrl);
    if (!name) return notify("请填写按钮名称");
    if (!url) return notify("请输入有效的 HTTP 或 HTTPS 链接");
    saveQuickLinks(quickLinks.map(link => link.id === editingQuickLinkId
      ? { ...link, project, name, url }
      : link));
    closeQuickLinkEditor();
    notify(`快捷按钮“${name}”已更新`);
  };

  const openQuickLink = (link: QuickLink) => {
    const url = normalizeQuickLink(link.url);
    if (!url) return notify("该链接格式无效，请删除后重新添加");
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) notify("浏览器阻止了新窗口，请允许此页面打开链接");
  };

  const importQuickLinks = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = parseQuickLinkConfig(decodeChineseConfig(await file.arrayBuffer()));
      if (!imported.length) return notify("配置文件中未识别到有效的“按钮名称,链接地址”");
      const deduplicated = [...quickLinks, ...imported].filter((link, index, links) =>
        links.findIndex(item => item.project === link.project && item.name === link.name && item.url === link.url) === index);
      saveQuickLinks(deduplicated);
      notify(`已导入 ${deduplicated.length - quickLinks.length} 个快捷按钮`);
    } catch {
      notify("配置文件读取失败，请检查文件是否为常用中文文本格式");
    }
  };

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-mark">R</div>
        <button className={`rail-btn ${workspaceView === "tools" ? "active" : ""}`} aria-label="小工具工作台" onClick={() => setWorkspaceView("tools")}>⌂</button>
        <button className={`rail-btn ${workspaceView === "compare" ? "active" : ""}`} aria-label="版本对比" onClick={() => setWorkspaceView("compare")}>⇄</button>
        <button className={`rail-btn ${workspaceView === "quick-links" ? "active" : ""}`} aria-label="快捷路径工具" onClick={() => setWorkspaceView("quick-links")}>↗</button>
        <div className="rail-spacer" />
        <button className="avatar" aria-label="当前用户">林</button>
      </aside>

      <section className="workspace">
        <header className={`topbar tool-home-topbar ${workspaceView !== "tools" ? "view-hidden" : ""}`}>
          <div>
            <div className="eyebrow">SYE / LOCAL TOOLBOX</div>
            <div className="title-row"><h1>本地小工具工作台</h1><span className="local-badge">● 本地优先</span></div>
            <p className="tool-home-subtitle">常用文档对比与路径工具集中入口，按需打开、互不干扰。</p>
          </div>
        </header>

        <section className={`tool-home ${workspaceView !== "tools" ? "view-hidden" : ""}`}>
          <button className="tool-card tool-card-primary" onClick={() => { setComparisonMethod("local"); setWorkspaceView("compare"); }}><span>⇄</span><div><strong>本地版本对比</strong><small>逐行查看已有版本的新增、删除与修改</small></div><b>打开 →</b></button>
          <button className="tool-card" onClick={() => { setComparisonMethod("beyond"); setWorkspaceView("compare"); }}><span>BC</span><div><strong>Beyond Compare</strong><small>选择两个本机文档并调用桌面程序</small></div><b>打开 →</b></button>
          <button className="tool-card" onClick={() => { setComparisonMethod("ai"); setWorkspaceView("compare"); }}><span>AI</span><div><strong>AI 对比</strong><small>预留语义分析入口，外部服务默认关闭</small></div><b>打开 →</b></button>
          <button className="tool-card" onClick={() => setWorkspaceView("quick-links")}><span>↗</span><div><strong>快捷路径</strong><small>按项目管理常用网页和内部系统入口</small></div><b>打开 →</b></button>
          <div className="tool-info-card"><span>LOCAL</span><strong>本地安全模式</strong><small>文档对比和快捷路径配置默认仅在当前电脑处理。</small></div>
          <div className="tool-info-card"><span>STATUS</span><strong>{history.length} 个历史版本</strong><small>历史记录仅用于版本对比，不在首页提供基线建立入口。</small></div>
        </section>
        <div className={`quick-path-workspace ${workspaceView !== "quick-links" ? "view-hidden" : ""}`}>
          <header className="topbar quick-path-topbar">
            <div>
              <div className="eyebrow">需求工作空间 / 本地效率工具</div>
              <div className="title-row">
                <h1>快捷路径工具</h1>
                <span className="local-badge">● 本地保存</span>
              </div>
            </div>
            <div className="quick-path-count">{quickLinks.length} 个已保存按钮</div>
          </header>

        <section className="quick-links card" ref={quickLinksRef}>
          {quickLinkScreen === "edit" ? (
            <div className="quick-link-edit-screen">
              <div className="quick-link-edit-head">
                <button onClick={closeQuickLinkEditor}>← 返回快捷路径</button>
                <div>
                  <span className="section-kicker">EDIT QUICK PATH</span>
                  <h2>修改快捷按钮</h2>
                  <p>修改项目归属、按钮名称或链接地址，保存后立即更新本地配置。</p>
                </div>
              </div>
              <div className="quick-link-edit-form">
                <label>项目名称<input value={editingQuickLinkProject} onChange={event => setEditingQuickLinkProject(event.target.value)} /></label>
                <label>按钮名称<input value={editingQuickLinkName} onChange={event => setEditingQuickLinkName(event.target.value)} /></label>
                <label>在线地址 / 链接<input value={editingQuickLinkUrl} onChange={event => setEditingQuickLinkUrl(event.target.value)} /></label>
                <div className="quick-link-edit-actions">
                  <button className="ghost" onClick={closeQuickLinkEditor}>取消</button>
                  <button className="primary" onClick={saveQuickLinkEdit}>保存修改</button>
                </div>
              </div>
            </div>
          ) : (<>
          <div className="quick-links-heading">
            <div>
              <span className="section-kicker">QUICK PATHS</span>
              <h2>快捷路径工具</h2>
              <p>保存常用在线地址，点击按钮后由浏览器直接打开。配置导入兼容 UTF-8、UTF-16、GBK、GB2312 和 GB18030。</p>
            </div>
            <button className="quick-import" onClick={() => quickLinkFileInputRef.current?.click()}>
              导入配置文件
            </button>
            <input
              ref={quickLinkFileInputRef}
              className="hidden-input"
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={event => void importQuickLinks(event)}
            />
          </div>

          <div className="quick-link-editor">
            <label>
              <span>项目名称</span>
              <input
                value={quickLinkProject}
                onChange={event => setQuickLinkProject(event.target.value)}
                placeholder="例如：Nova 项目"
              />
            </label>
            <label>
              <span>按钮名称</span>
              <input
                value={quickLinkName}
                onChange={event => setQuickLinkName(event.target.value)}
                placeholder="例如：项目需求库"
              />
            </label>
            <label>
              <span>在线地址 / 链接</span>
              <input
                value={quickLinkUrl}
                onChange={event => setQuickLinkUrl(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter") addQuickLink();
                }}
                placeholder="https://example.com 或内网地址"
              />
            </label>
            <button onClick={addQuickLink}>添加快捷按钮</button>
          </div>

          <div className="quick-project-list">
            {groupedQuickLinks.length ? groupedQuickLinks.map(group => (
              <section className="quick-project" key={group.project}>
                <div className="quick-project-head">
                  <div><span>PROJECT</span><h3>{group.project}</h3></div>
                  <small>{group.links.length} 个按钮</small>
                </div>
                <div className="quick-link-list">
                  {group.links.map(link => (
                    <div className="quick-link-item" key={link.id}>
                      <button className="quick-open" onClick={() => openQuickLink(link)}>
                        <span>↗</span>
                        <strong>{link.name}</strong>
                        <small>{link.url}</small>
                      </button>
                      <div className="quick-link-manage">
                        <button aria-label={`修改快捷路径 ${link.name}`} onClick={() => openQuickLinkEditor(link)}>修改</button>
                        <button
                          className="quick-remove"
                          aria-label={`删除快捷路径 ${link.name}`}
                          onClick={() => {
                            saveQuickLinks(quickLinks.filter(item => item.id !== link.id));
                            notify(`快捷按钮“${link.name}”已删除`);
                          }}
                        >×</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )) : (
              <div className="quick-links-empty">
                尚未添加快捷路径。支持：按钮名称,链接地址；或：项目名称,按钮名称,链接地址
              </div>
            )}
          </div>
          </>)}
        </section>
        </div>

        <header className={`topbar compare-tool-topbar ${workspaceView !== "compare" ? "view-hidden" : ""}`}>
          <div><div className="eyebrow">SYE / DOCUMENT TOOLS</div><div className="title-row"><h1>文档版本对比工具</h1><span className="local-badge">● 按需使用</span></div></div>
          <button className="ghost" onClick={() => setWorkspaceView("tools")}>← 返回工具台</button>
        </header>
        <section className={`main-grid compare-workspace ${workspaceView !== "compare" ? "view-hidden" : ""}`}>
          <div className="main-column">
            <section className={`card compare-card ${compareFullscreen ? "compare-fullscreen" : ""}`}>
              <div className="card-head compare-heading">
                <div>
                  <span className="section-kicker">VERSION DIFF</span>
                  <h2>版本对比</h2>
                </div>
                <div className="compare-heading-actions">
                  {comparisonMethod === "local" && (
                    <div className="diff-legend">
                      <span className="legend-added">新增</span>
                      <span className="legend-deleted">删除</span>
                      <span className="legend-changed">修改</span>
                    </div>
                  )}
                  {comparisonMethod === "local" && (
                    <button
                      className="fullscreen-button"
                      onClick={() => setCompareFullscreen(current => !current)}
                      aria-label={compareFullscreen ? "退出全屏版本对比" : "全屏查看版本对比"}
                    >
                      {compareFullscreen ? "↙ 退出全屏" : "⛶ 放大全屏"}
                    </button>
                  )}
                </div>
              </div>

              <nav className="compare-methods" aria-label="对比方式">
                <button
                  className={comparisonMethod === "local" ? "active" : ""}
                  onClick={() => setComparisonMethod("local")}
                >
                  <b>本地算法对比</b><small>内置 · 无外部连接</small>
                </button>
                <button
                  className={comparisonMethod === "beyond" ? "active" : ""}
                  onClick={() => {
                    setComparisonMethod("beyond");
                    setCompareFullscreen(false);
                    setBeyondLeftPath(boundComparisonPath(selectedBaseVersion));
                    setBeyondRightPath(boundComparisonPath(selectedTargetVersion));
                    setBeyondLeftVersionId(baseVersionId);
                    setBeyondRightVersionId(targetVersionId);
                  }}
                >
                  <b>Beyond Compare</b><small>调用本机程序</small>
                </button>
                <button
                  className={comparisonMethod === "ai" ? "active" : ""}
                  onClick={() => {
                    setComparisonMethod("ai");
                    setCompareFullscreen(false);
                  }}
                >
                  <b>AI 对比</b><small>尚未配置</small>
                </button>
              </nav>

              {comparisonMethod === "local" && (comparableVersions.length < 2 ? (
                <div className="compare-empty">
                  <span>⇄</span>
                  <p>暂无两个可比较的历史版本</p>
                  <small>当前工具仅使用本机已有的版本快照，不提供新的基线建立入口。</small>
                </div>
              ) : (
                <>
                  <div className="compare-controls">
                    <label>
                      <span>基准版本</span>
                      <select value={baseVersionId} onChange={event => {
                        setBaseVersionId(event.target.value);
                        setDiffRows([]);
                        setActiveDiffId("");
                      }}>
                        {comparableVersions.map(item => <option value={item.id} key={`base-${item.id}`}>{item.version} · {item.id}</option>)}
                      </select>
                    </label>
                    <button className="swap-button" onClick={() => {
                      setBaseVersionId(targetVersionId);
                      setTargetVersionId(baseVersionId);
                      setDiffRows([]);
                      setActiveDiffId("");
                    }} aria-label="交换比较版本">⇄</button>
                    <label>
                      <span>目标版本</span>
                      <select value={targetVersionId} onChange={event => {
                        setTargetVersionId(event.target.value);
                        setDiffRows([]);
                        setActiveDiffId("");
                      }}>
                        {comparableVersions.map(item => <option value={item.id} key={`target-${item.id}`}>{item.version} · {item.id}</option>)}
                      </select>
                    </label>
                    <button className="compare-button" onClick={runComparison}>开始对比</button>
                  </div>
                  <div className="compare-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={ignoreWhitespace}
                        onChange={event => {
                          setIgnoreWhitespace(event.target.checked);
                          setDiffRows([]);
                          setActiveDiffId("");
                        }}
                      />
                      忽略空格与制表符差异
                    </label>
                    <span>本地混合算法：Histogram 稳定锚点 + Myers 逐行对齐 + 行内字符差异</span>
                  </div>

                  {diffRows.length > 0 ? (
                    <div className="diff-result">
                      <div className="diff-summary">
                        <div className="diff-summary-counts">
                          <span><b>{diffStats.changed}</b> 修改</span>
                          <span><b>{diffStats.added}</b> 新增</span>
                          <span><b>{diffStats.deleted}</b> 删除</span>
                          <span><b>{diffStats.same}</b> 相同</span>
                        </div>
                        <div className="diff-tools">
                          <label>
                            <input
                              type="checkbox"
                              checked={showDifferencesOnly}
                              onChange={event => setShowDifferencesOnly(event.target.checked)}
                            />
                            仅显示差异
                          </label>
                          <button onClick={() => jumpToDifference(-1)} disabled={!differenceRows.length}>↑ 上一处</button>
                          <button onClick={() => jumpToDifference(1)} disabled={!differenceRows.length}>↓ 下一处</button>
                          <small>
                            {differenceRows.length
                              ? `${Math.max(1, differenceRows.findIndex(row => row.id === activeDiffId) + 1)} / ${differenceRows.length}`
                              : "0 / 0"}
                          </small>
                        </div>
                      </div>
                      <div className="diff-pane-head">
                        <div>
                          <span>基准文档</span>
                          <strong>{comparableVersions.find(item => item.id === baseVersionId)?.version}</strong>
                        </div>
                        <div>
                          <span>目标文档</span>
                          <strong>{comparableVersions.find(item => item.id === targetVersionId)?.version}</strong>
                        </div>
                      </div>
                      <div className="diff-viewport" ref={diffViewportRef}>
                        {visibleDiffRows.map(row => row.type === "file" ? (
                          <div className={`diff-file-row file-${row.fileStatus}`} key={row.id}>
                            <div>
                              <strong>{row.left || "—"}</strong>
                              {!row.left && <span>新增文件</span>}
                            </div>
                            <div>
                              <strong>{row.right || "—"}</strong>
                              <span className={`file-status status-${row.fileStatus}`}>
                                {row.fileStatus === "same" ? "相同" : row.fileStatus === "added" ? "新增" : row.fileStatus === "deleted" ? "删除" : "有修改"}
                              </span>
                              <span className="comparison-mode">{row.comparisonMode === "content" ? "正文对比" : "文件属性对比"}</span>
                            </div>
                          </div>
                        ) : (
                          <div
                            className={`diff-row diff-${row.type} ${row.id === activeDiffId ? "active-diff" : ""}`}
                            data-diff-id={row.id}
                            key={row.id}
                          >
                            <div className="diff-side">
                              <span className="line-number">{row.leftNumber ?? ""}</span>
                              <code>{renderDiffText(row.leftSegments, row.left, "left")}</code>
                            </div>
                            <div className="diff-side">
                              <span className="line-number">{row.rightNumber ?? ""}</span>
                              <code>{renderDiffText(row.rightSegments, row.right, "right")}</code>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="compare-ready"><span>⇄</span><p>选择两个版本，查看逐行内容差异</p></div>
                  )}
                </>
              ))}

              {comparisonMethod === "beyond" && (
                <div className="beyond-panel">
                  <div className={`integration-status ${beyondStatus?.installed ? "available" : ""}`}>
                    <span>{beyondStatus?.installed ? "✓" : "!"}</span>
                    <div>
                      <strong>{beyondStatus?.installed ? `已检测到 Beyond Compare ${beyondStatus.version}` : "未自动检测到 Beyond Compare"}</strong>
                      <small>{beyondStatus?.installed
                        ? "已使用本机程序；可以选择历史版本路径，也可以手动选择两个本机文档。"
                        : "未找到本机程序，请先选择 BCompare.exe，再填写两个版本的文档路径。"}</small>
                    </div>
                  </div>

                  <div className="beyond-fields">
                    {!beyondStatus?.installed && (
                      <label className="beyond-program-fallback">
                        <span>Beyond Compare 程序路径</span>
                        <div className="path-input">
                          <input
                            value={beyondExecutable}
                            onChange={event => setBeyondExecutable(event.target.value)}
                            placeholder="例如 C:\Program Files\Beyond Compare 5\BCompare.exe"
                          />
                          <button
                            onClick={() => void pickBeyondComparePath("program", setBeyondExecutable)}
                            disabled={beyondPicking}
                          >选择程序</button>
                        </div>
                      </label>
                    )}

                    <div className="beyond-version-controls">
                      <label>
                        <span>基准版本</span>
                        <select value={baseVersionId} disabled={!history.length} onChange={event => {
                          const nextId = event.target.value;
                          setBaseVersionId(nextId);
                          setBeyondLeftPath(boundComparisonPath(history.find(item => item.id === nextId)));
                          setBeyondLeftVersionId(nextId);
                        }}>
                          {!history.length && <option value="">尚无归档版本</option>}
                          {history.map(item => (
                            <option value={item.id} key={`beyond-base-${item.id}`}>{item.version} · {item.id}</option>
                          ))}
                        </select>
                      </label>
                      <span>对比</span>
                      <label>
                        <span>修改版本</span>
                        <select value={targetVersionId} disabled={!history.length} onChange={event => {
                          const nextId = event.target.value;
                          setTargetVersionId(nextId);
                          setBeyondRightPath(boundComparisonPath(history.find(item => item.id === nextId)));
                          setBeyondRightVersionId(nextId);
                        }}>
                          {!history.length && <option value="">尚无归档版本</option>}
                          {history.map(item => (
                            <option value={item.id} key={`beyond-target-${item.id}`}>{item.version} · {item.id}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="beyond-document-paths">
                      <label>
                        <span>基准版本文档路径 · {selectedBaseVersion?.version || "未选择版本"}</span>
                        <div className="path-input">
                          <input
                            value={beyondLeftPath}
                            onChange={event => setBeyondLeftPath(event.target.value)}
                            onBlur={() => persistComparisonBindings([
                              { versionId: baseVersionId, path: beyondLeftPath },
                            ])}
                            list={`base-source-paths-${baseVersionId}`}
                            placeholder={selectedBaseVersion?.snapshots?.[0]?.path
                              ? `选择“${selectedBaseVersion.snapshots[0].path}”的本机完整路径`
                              : "输入或选择基准版本文档完整路径"}
                          />
                          <datalist id={`base-source-paths-${baseVersionId}`}>
                            {selectedBaseVersion?.sourcePaths?.map(source => (
                              <option value={source.path} key={`base-source-${source.path}`}>{source.name}</option>
                            ))}
                          </datalist>
                          <button
                            onClick={() => void pickBeyondComparePath("document", path => {
                              setBeyondLeftPath(path);
                              persistComparisonBindings([{ versionId: baseVersionId, path }]);
                            })}
                            disabled={beyondPicking}
                          >选择文件</button>
                        </div>
                        <small className="path-binding-note">
                          {selectedBaseVersion?.beyondComparePath
                            ? "已绑定手动路径，可继续修改"
                            : selectedBaseVersion?.sourcePaths?.length
                              ? "已绑定添加时路径，可手动修改"
                              : "尚未绑定路径，请手动选择文件"}
                        </small>
                      </label>
                      <button
                        className="path-swap-button"
                        onClick={() => {
                          setBeyondLeftPath(beyondRightPath);
                          setBeyondRightPath(beyondLeftPath);
                        }}
                        aria-label="交换左右文档路径"
                      >⇄</button>
                      <label>
                        <span>修改版本文档路径 · {selectedTargetVersion?.version || "未选择版本"}</span>
                        <div className="path-input">
                          <input
                            value={beyondRightPath}
                            onChange={event => setBeyondRightPath(event.target.value)}
                            onBlur={() => persistComparisonBindings([
                              { versionId: targetVersionId, path: beyondRightPath },
                            ])}
                            list={`target-source-paths-${targetVersionId}`}
                            placeholder={selectedTargetVersion?.snapshots?.[0]?.path
                              ? `选择“${selectedTargetVersion.snapshots[0].path}”的本机完整路径`
                              : "输入或选择修改版本文档完整路径"}
                          />
                          <datalist id={`target-source-paths-${targetVersionId}`}>
                            {selectedTargetVersion?.sourcePaths?.map(source => (
                              <option value={source.path} key={`target-source-${source.path}`}>{source.name}</option>
                            ))}
                          </datalist>
                          <button
                            onClick={() => void pickBeyondComparePath("document", path => {
                              setBeyondRightPath(path);
                              persistComparisonBindings([{ versionId: targetVersionId, path }]);
                            })}
                            disabled={beyondPicking}
                          >选择文件</button>
                        </div>
                        <small className="path-binding-note">
                          {selectedTargetVersion?.beyondComparePath
                            ? "已绑定手动路径，可继续修改"
                            : selectedTargetVersion?.sourcePaths?.length
                              ? "已绑定添加时路径，可手动修改"
                              : "尚未绑定路径，请手动选择文件"}
                        </small>
                      </label>
                    </div>
                  </div>

                  <div className="beyond-actions">
                    <p>点击后直接启动本机 Beyond Compare；路径仅保存在当前电脑，不会写入归档或发送到外部服务。</p>
                    <button onClick={() => void launchBeyondCompare()}>
                      {`打开 Beyond Compare：${selectedBaseVersion?.version || "基准版本"} ↔ ${selectedTargetVersion?.version || "修改版本"}`}
                    </button>
                  </div>
                </div>
              )}

              {comparisonMethod === "ai" && (
                <div className="ai-compare-panel">
                  <div className="ai-icon">AI</div>
                  <h3>AI 对比尚未配置</h3>
                  <p>当前系统保持纯本地安全模式，不会把需求文档发送到外部模型。</p>
                  <small>后续可接入公司批准的本地大模型，对差异进行语义归纳、影响分析和需求变更分类。</small>
                  <button disabled>等待配置本地 AI 服务</button>
                </div>
              )}
            </section>

          </div>

        </section>
      </section>
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}
