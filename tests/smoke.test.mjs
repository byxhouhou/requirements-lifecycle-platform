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

test("development mode opens the browser file chooser synchronously", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /window\.location\.port === "37651"/);
  assert.match(page, /fileInputRef\.current\?\.click\(\)/);
  assert.match(page, /folderInputRef\.current\?\.click\(\)/);
  assert.match(page, /aria-label="选择一个或多个需求文档"/);
  assert.match(page, /void chooseDocuments\("files"\)/);
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
  assert.match(page, /type WorkspaceView = "requirements" \| "quick-links"/);
  assert.match(page, /setWorkspaceView\("quick-links"\)/);
  assert.match(page, /workspaceView !== "requirements" \? "view-hidden"/);
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

test("Windows package embeds the generated SYE application icon", async () => {
  const script = await readFile(new URL("../launcher/build-exe.ps1", import.meta.url), "utf8");

  assert.match(script, /SYE-tile-green\.png/);
  assert.match(script, /\$iconSizes = @\(16, 20, 24, 32, 40, 48, 64, 128, 256\)/);
  assert.match(script, /\$iconWriter\.Write\(\[uint16\]\$iconSizes\.Count\)/);
  assert.match(script, /\/win32icon:\$iconOutput/);
  assert.match(script, /SYE-icon\.png/);
});

test("local Git projects create repositories and commit tagged baselines", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../launcher/ReqFlowLauncher.cs", import.meta.url), "utf8");

  assert.match(page, /\/api\/git-projects\/create/);
  assert.match(page, /\/api\/git-projects\/commit/);
  assert.match(page, /currentProject\.path/);
  assert.match(page, /Commit \+ Tag \+ 元数据/);
  assert.match(launcher, /RunGit\(projectPath, "init"/);
  assert.match(launcher, /RunGit\(projectPath, "commit -m "/);
  assert.match(launcher, /RunGit\(projectPath, "tag -a "/);
  assert.match(launcher, /metadata", "baselines/);
  assert.match(launcher, /未找到本机 Git/);
});
