"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "2.2.0");
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
