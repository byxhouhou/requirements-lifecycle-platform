import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production build contains the local ReqFlow entry page", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /ReqFlow/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
});

test("Windows release includes a verified standalone updater", async () => {
  const executable = await readFile(new URL("../release/ReqFlow.exe", import.meta.url));
  const updater = await readFile(new URL("../release/ReqFlowUpdater.exe", import.meta.url));
  const hashFile = await readFile(new URL("../release/ReqFlow.exe.sha256", import.meta.url), "utf8");
  const expectedHash = hashFile.match(/[A-Fa-f0-9]{64}/)?.[0];
  const actualHash = createHash("sha256").update(executable).digest("hex");

  assert.equal(executable.subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(updater.subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(actualHash.toUpperCase(), expectedHash?.toUpperCase());
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

  assert.match(script, /DrawString\("SYE"/);
  assert.match(script, /\/win32icon:\$iconOutput/);
  assert.match(script, /SYE-icon\.png/);
});
