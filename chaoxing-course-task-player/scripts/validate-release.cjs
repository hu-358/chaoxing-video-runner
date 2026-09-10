"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "2.2.0");
assert.equal(manifest.default_locale, "zh_CN");
assert.equal(manifest.name, "__MSG_extensionName__");
assert.equal(manifest.description, "__MSG_extensionDescription__");
const zhMessages = JSON.parse(
  fs.readFileSync(path.join(extension, "_locales", "zh_CN", "messages.json"), "utf8"),
);
assert.equal(zhMessages.extensionName.message, "学习通课程任务播放器（通用版）");
assert.equal(
  zhMessages.extensionDescription.message,
  "用户主动启动后，自动依次播放学习通课程视频、浏览官方文档，并仅在本地记录任务进度与异常。",
);
assert.deepEqual(manifest.permissions.sort(), ["notifications", "storage"]);
assert.equal(manifest.host_permissions, undefined);
assert.equal(JSON.stringify(manifest).includes("http://"), false);
assert.equal(manifest.action.default_popup, "pages/popup.html");

for (const required of [
  "background.js",
  "content.js",
  "document-viewer.js",
  "icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "pages/onboarding.html",
  "pages/demo.html",
  "pages/privacy.html",
  "pages/popup.html"
]) {
  assert.ok(fs.existsSync(path.join(extension, required)), `Missing ${required}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

for (const file of walk(extension).filter((name) => /\.(?:js|html|css|json)$/.test(name))) {
  const source = fs.readFileSync(file, "utf8");
  assert.equal(/<script[^>]+src=["']https?:\/\//i.test(source), false, `Remote script in ${file}`);
  assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(source), false, `Dynamic code in ${file}`);
}

console.log("Release validation passed.");
