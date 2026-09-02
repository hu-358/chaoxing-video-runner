"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

async function testManifest() {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "2.1.1");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("notifications"));
  const viewerScript = manifest.content_scripts.find((item) => item.js.includes("document-viewer.js"));
  assert.ok(viewerScript, "document-viewer.js must be registered");
  assert.equal(viewerScript.all_frames, true);
  assert.ok(viewerScript.matches.some((match) => match.includes("/ananas/modules/pdf/index.html")));
  assert.ok(fs.existsSync(path.join(root, "icon-128.png")));
}

async function testViewerTraversal() {
  const posted = [];
  const listeners = {};
  let scrollTop = 0;
  let maskClicks = 0;
  const parent = { postMessage: (message) => posted.push(message) };
  const pages = [0, 640, 1280].map((offsetTop, index) => ({
    id: `anchor${index + 1}`,
    offsetTop
  }));
  const scrollingElement = {
    clientHeight: 640,
    scrollHeight: 1920,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; }
  };
  const panDocument = {
    documentElement: scrollingElement,
    scrollingElement,
    body: scrollingElement,
    querySelectorAll(selector) {
      return selector === "li[id^='anchor']" || selector === "li" ? pages : [];
    }
  };
  const panView = {
    contentWindow: {
      document: panDocument,
      innerHeight: 640,
      scrollTo(_x, y) {
        scrollTop = Math.min(y, scrollingElement.scrollHeight);
      }
    }
  };
  const elements = {
    container: { isConnected: true },
    mask: {
      isConnected: true,
      click() {
        maskClicks += 1;
      }
    },
    next: null
  };
  const document = {
    querySelector(selector) {
      if (selector === "#docContainer") return elements.container;
      if (selector === "#maskLayer") return elements.mask;
      if (selector === ".nextBtn") return elements.next;
      if (selector === "#panView") return panView;
      return null;
    }
  };
  const window = {
    parent,
    top: parent,
    location: { href: "https://mooc1.chaoxing.com/ananas/modules/pdf/index.html" },
    setTimeout,
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  const context = vm.createContext({
    window,
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout,
    Promise,
    Date,
    String,
    Number,
    Math,
    Error
  });
  vm.runInContext(read("document-viewer.js"), context, { filename: "document-viewer.js" });
  listeners.message({
    source: parent,
    data: { source: "cxvu-document-parent-v1", type: "start", jobId: "doc-1" }
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(scrollTop, 1920);
  assert.ok(maskClicks >= 1);
  assert.ok(posted.some((message) => message.type === "started" && message.jobId === "doc-1"));
  assert.ok(posted.some((message) => message.type === "progress" && message.current === 3));
  assert.ok(posted.some((message) => message.type === "traversed" && message.total === 3));
}

async function testImplementationMarkers() {
  const content = read("content.js");
  assert.match(content, /DOCUMENT_FRAME_SELECTOR/);
  assert.match(content, /pauseForDocumentFailure/);
  assert.match(content, /const STATE_SCHEMA = 2/);
  assert.match(content, /recoverMissingDocumentEntry/);
  assert.match(content, /replaceDocuments:\s*true/);
  assert.doesNotMatch(content, /未找到文档节点，10秒后重试/);
  assert.match(content, /phase:\s*"paused_failure"/);
  assert.match(content, /notification:show/);
  assert.match(content, /documentCompleted/);
  assert.doesNotMatch(content, /\/ananas\/job\/document\?/);
  const documentDiscovery = content.slice(
    content.indexOf("function getLiveDocumentEntries"),
    content.indexOf("function getFreshDocumentEntry")
  );
  assert.doesNotMatch(documentDiscovery, /data\._jobid|property\._jobid/);
  assert.match(read("document-viewer.js"), /panView\.view\.scrollTo/);
}

async function testBackgroundNotification() {
  const storage = {};
  const notifications = [];
  let listener;
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(value) { Object.assign(storage, value); },
        async remove(key) { delete storage[key]; }
      }
    },
    runtime: {
      getURL(name) { return `chrome-extension://test/${name}`; },
      onMessage: { addListener(value) { listener = value; } }
    },
    notifications: {
      async create(id, options) {
        notifications.push({ id, options });
        return id;
      }
    }
  };
  vm.runInNewContext(read("background.js"), { chrome, Promise, Date, String, Number, Object });
  assert.equal(typeof listener, "function");
  const response = await new Promise((resolve) => {
    listener({
      type: "notification:show",
      courseKey: "1:2",
      title: "完成",
      message: "课程已完成"
    }, { tab: { id: 1 } }, resolve);
  });
  assert.equal(response.ok, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.iconUrl, "chrome-extension://test/icon-128.png");
}

(async () => {
  await testManifest();
  await testViewerTraversal();
  await testImplementationMarkers();
  await testBackgroundNotification();
  console.log("smoke tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
