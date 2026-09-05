import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuickLink, isFileQuickLink } from '../.test-build/quick-link-utils.js';

test('web and signed cloud links retain their query and fragment', () => {
  const url = 'https://cloud.example.com/file?id=42&token=a%2Fb#preview';
  assert.equal(normalizeQuickLink(url), url);
  assert.equal(normalizeQuickLink('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeQuickLink('//cloud.example.com/file'), 'https://cloud.example.com/file');
});
test('UNC and file URLs resolve to Windows paths without https prefix', () => {
  const path = String.raw`\\server\share\需求 模板.docx`;
  assert.equal(normalizeQuickLink(path), path);
  assert.equal(normalizeQuickLink('file://server/share/%E9%9C%80%E6%B1%82%20%E6%A8%A1%E6%9D%BF.docx'), path);
  assert.equal(normalizeQuickLink('file:///C:/Templates/test.docx'), String.raw`C:\Templates\test.docx`);
  assert.equal(normalizeQuickLink('C:/Templates/test.docx'), String.raw`C:\Templates\test.docx`);
  assert.equal(isFileQuickLink(path), true);
  assert.equal(isFileQuickLink('https://example.com'), false);
});
test('unsafe and unsupported protocols are rejected', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:foo', 'shell:AppsFolder', 'https://user:secret@example.com', '']) assert.equal(normalizeQuickLink(value), '');
});
