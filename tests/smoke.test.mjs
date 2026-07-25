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

test("Windows launcher exposes only explicit local Beyond Compare integration routes", async () => {
  const launcher = await readFile(new URL("../launcher/ReqFlowLauncher.cs", import.meta.url), "utf8");

  assert.match(launcher, /\/api\/integrations\/beyond-compare\/status/);
  assert.match(launcher, /\/api\/integrations\/beyond-compare\/pick/);
  assert.match(launcher, /\/api\/integrations\/beyond-compare\/launch/);
  assert.match(launcher, /X-ReqFlow-Integration/);
  assert.match(launcher, /ValidateBeyondCompareExecutable/);
  assert.match(launcher, /ValidateDocumentPath/);
});
