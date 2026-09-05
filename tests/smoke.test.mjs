import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production build contains the local ReqFlow entry page", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /ReqFlow/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
});

test("Windows release provides a cache-safe SYE executable entry", async () => {
  const executable = await readFile(new URL("../release/SYE.exe", import.meta.url));

  assert.ok(executable.length > 100_000);
  assert.equal(executable.subarray(0, 2).toString("ascii"), "MZ");
});

test("SYE uses the separate user-triggered updater", async () => {
  const launcher = await readFile(new URL("../launcher/ReqFlowLauncher.cs", import.meta.url), "utf8");
  const updater = await readFile(new URL("../launcher/ReqFlowUpdater.cs", import.meta.url), "utf8");
  const script = await readFile(new URL("../launcher/build-exe.ps1", import.meta.url), "utf8");

  assert.match(launcher, /LaunchUpdater/);
  assert.match(launcher, /检查更新/);
  assert.match(launcher, /SYEUpdater\.exe/);
  assert.match(launcher, /Icon\.ExtractAssociatedIcon/);
  assert.match(updater, /release\/SYE\.exe/);
  assert.match(script, /\$updaterOutput = Join-Path \$releaseDir "SYEUpdater\.exe"/);
});

test("Windows launcher exposes explicit local file and Beyond Compare integration routes", async () => {
  const launcher = await readFile(new URL("../launcher/ReqFlowLauncher.cs", import.meta.url), "utf8");

  assert.match(launcher, /\/api\/local-files\/pick/);
  assert.match(launcher, /\/api\/local-files\/read\//);
  assert.match(launcher, /localFileTokens/);
  assert.match(launcher, /ShowOwnedDialog/);
  assert.match(launcher, /Screen\.FromPoint\(Cursor\.Position\)/);
  assert.match(launcher, /EnumThreadWindows/);
  assert.match(launcher, /SetWindowPos/);
  assert.match(launcher, /SetForegroundWindow/);
  assert.doesNotMatch(launcher, /Point\(-32000, -32000\)/);
  assert.match(launcher, /\/api\/integrations\/beyond-compare\/status/);
  assert.match(launcher, /\/api\/integrations\/beyond-compare\/pick/);
  assert.match(launcher, /\/api\/integrations\/beyond-compare\/launch/);
  assert.match(launcher, /X-ReqFlow-Integration/);
  assert.match(launcher, /ValidateBeyondCompareExecutable/);
  assert.match(launcher, /ValidateDocumentPath/);
});

test("home page is a local toolbox without baseline creation elements", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /type WorkspaceView = "tools" \| "compare" \| "quick-links" \| "extract" \| "reviews" \| "tasks" \| "templates"/);
  assert.match(page, /今天想处理什么/);
  assert.match(page, /setWorkspaceView\("compare"\)/);
  assert.match(page, /setWorkspaceView\("quick-links"\)/);
  assert.doesNotMatch(page, /className="card source-card"/);
  assert.doesNotMatch(page, /className="commit-panel card"/);
  assert.doesNotMatch(page, /className="card history-card"/);
});
test("Beyond Compare resolves selected version paths at launch time", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /beyondComparePath\?: string/);
  assert.match(page, /beyondLeftVersionId !== baseVersionId/);
  assert.match(page, /beyondRightVersionId !== targetVersionId/);
  assert.match(page, /setBeyondLeftVersionId\(nextId\)/);
  assert.match(page, /setBeyondRightVersionId\(nextId\)/);
  assert.match(page, /const leftPath = beyondLeftPath\.trim\(\) \|\| boundComparisonPath\(selectedBaseVersion\)/);
  assert.match(page, /const rightPath = beyondRightPath\.trim\(\) \|\| boundComparisonPath\(selectedTargetVersion\)/);
  assert.match(page, /persistComparisonBindings/);
  assert.match(page, /setBeyondLeftPath\(leftPath\)/);
  assert.match(page, /setBeyondRightPath\(rightPath\)/);
});

test("quick path tool imports, persists, validates and opens configured links", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /parseQuickLinkConfig/);
  assert.match(page, /normalizeQuickLink/);
  assert.match(page, /quickLinks: Array\.isArray\(payload\.quickLinks\)/);
  assert.match(page, /accept="\.csv,\.txt,text\/csv,text\/plain"/);
  assert.match(page, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(page, /按钮名称,链接地址/);
  assert.match(page, /type WorkspaceView = "tools" \| "compare" \| "quick-links" \| "extract" \| "reviews" \| "tasks" \| "templates"/);
  assert.match(page, /setWorkspaceView\("quick-links"\)/);
  assert.match(page, /workspaceView !== "compare" \? "view-hidden"/);
  assert.match(page, /workspaceView !== "quick-links" \? "view-hidden"/);
  assert.match(page, /decodeChineseConfig/);
  assert.match(page, /new TextDecoder\("gb18030"\)/);
  assert.match(page, /new TextDecoder\("utf-16le"\)/);
  assert.match(page, /file\.arrayBuffer\(\)/);
  assert.match(page, /project: string/);
  assert.match(page, /DEFAULT_QUICK_LINK_PROJECT = "默认项目"/);
  assert.match(page, /type QuickLinkScreen = "list" \| "edit"/);
  assert.match(page, /openQuickLinkEditor/);
  assert.match(page, /saveQuickLinkEdit/);
  assert.match(page, /groupedQuickLinks\.map/);
});

test("Apple-style interface exposes a consistent labeled workspace navigation", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const theme = await readFile(new URL("../app/apple-ui.css", import.meta.url), "utf8");

  assert.match(page, /import "\.\/apple-ui\.css"/);
  assert.match(page, /本地需求工作台/);
  assert.match(page, /今天想处理什么/);
  assert.match(page, /<b>文档对比<\/b>/);
  assert.match(page, /<b>内容提取<\/b>/);
  assert.match(page, /<b>评审问题<\/b>/);
  assert.match(page, /<b>任务清单<\/b>/);
  assert.match(theme, /--apple-blue: #007aff/);
  assert.match(theme, /backdrop-filter: saturate\(180%\) blur\(30px\)/);
  assert.match(theme, /grid-template-columns: repeat\(4,minmax\(0,1fr\)\)/);
});
test("Windows package embeds the generated SYE application icon", async () => {
  const script = await readFile(new URL("../launcher/build-exe.ps1", import.meta.url), "utf8");

  assert.match(script, /SYE-tile-green\.png/);
  assert.match(script, /\$iconSizes = @\(16, 20, 24, 32, 40, 48, 64, 128, 256\)/);
  assert.match(script, /\$iconWriter\.Write\(\[uint16\]\$iconSizes\.Count\)/);
  assert.match(script, /\/win32icon:\$iconOutput/);
  assert.match(script, /SYE-icon\.png/);
});

test("template library stores files locally, previews supported content and removes screenshot functionality", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const diff = await readFile(new URL("../app/diff-utils.ts", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../launcher/ReqFlowLauncher.cs", import.meta.url), "utf8");

  assert.match(page, /模板目录/);
  assert.match(page, /TEMPLATE_DB_NAME = "sye-template-library"/);
  assert.match(page, /indexedDB\.open/);
  assert.match(page, /storeTemplate/);
  assert.match(page, /readStoredTemplates/);
  assert.match(page, /downloadTemplate/);
  assert.match(page, /templatePreviewUrl/);
  assert.match(page, /<iframe title=/);
  assert.match(diff, /document\.file\.text\(\)/);
  assert.doesNotMatch(page, /screenshot\/show|桌面悬浮截图|桌面截图/);
  assert.doesNotMatch(launcher, /Screenshot|screenshot|桌面截图|CopyFromScreen|Clipboard\.SetImage/);
});