"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.ok(functionStart >= 0, `${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

async function testManifest() {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "2.1.6");
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
  let timerCalls = 0;
  const imageListeners = {};
  const lazyImage = {
    complete: false,
    addEventListener(type, listener) {
      imageListeners[type] = listener;
    }
  };
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
    images: [lazyImage],
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
    frameElement: {
      getAttribute() { return null; },
      parentElement: {
        classList: { contains() { return false; } },
        querySelector() { return null; }
      }
    },
    location: { href: "https://mooc1.chaoxing.com/ananas/modules/pdf/index.html" },
    setTimeout(callback, delay) {
      timerCalls += 1;
      return setTimeout(callback, delay);
    },
    clearTimeout,
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = {
        close() {},
        postMessage: () => queueMicrotask(() => this.port1.onmessage?.())
      };
    }
  }
  const context = vm.createContext({
    window,
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MessageChannel: FakeMessageChannel,
    MutationObserver: FakeMutationObserver,
    queueMicrotask,
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
  setTimeout(() => {
    scrollingElement.scrollHeight = 2560;
    lazyImage.complete = true;
    imageListeners.load?.();
  }, 20);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(scrollTop, 2560);
  assert.ok(maskClicks >= 1);
  assert.ok(posted.some((message) => message.type === "started" && message.jobId === "doc-1"));
  assert.ok(posted.some((message) => message.type === "progress" && message.current === 3));
  assert.ok(posted.some((message) => message.type === "traversed" && message.total === 3));
  assert.equal(timerCalls, 1, "event-driven traversal should only create a watchdog timer");
}

async function testImplementationMarkers() {
  const content = read("content.js");
  assert.match(content, /DOCUMENT_FRAME_SELECTOR/);
  assert.match(content, /pauseForDocumentFailure/);
  assert.match(content, /const STATE_SCHEMA = 4/);
  assert.match(content, /recoverMissingDocumentEntry/);
  assert.match(content, /replaceDocuments:\s*true/);
  assert.doesNotMatch(content, /未找到文档节点，10秒后重试/);
  assert.match(content, /phase:\s*"paused_failure"/);
  assert.match(content, /notification:show/);
  assert.match(content, /documentCompleted/);
  assert.match(content, /multipleDocuments[\s\S]*navigateToLesson\(lesson, token, true\)/);
  assert.match(content, /最终核验进度完成/);
  assert.match(content, /mediaQuietMs:\s*4_000/);
  assert.match(content, /getCurrentPendingTaskCount/);
  assert.match(content, /meetsExpectedPendingTaskCount\(incompleteCount, expectedPendingCount\)/);
  assert.match(content, /generationChanged/);
  assert.match(content, /const courseLessons = \(await waitForCatalog\(token\)\)/);
  assert.match(content, /if \(!lessonExists && \(entries\.videos\.length > 0 \|\| entries\.documents\.length > 0\)\)/);
  assert.match(content, /return "needs_processing"/);
  assert.match(content, /verified === "needs_processing"/);
  assert.match(content, /id="collapse"/);
  assert.match(content, /classList\.toggle\("collapsed", panelLayout\.collapsed\)/);
  assert.match(content, /addEventListener\("pointerdown", beginPanelDrag\)/);
  assert.match(content, /addEventListener\("pointercancel", endPanelDrag\)/);
  assert.match(content, /event\.target\.closest\("button,select,input,a"\)/);
  assert.match(content, /type: "ui:panel:get"/);
  assert.match(content, /type: "ui:panel:set"/);
  assert.doesNotMatch(content, /\/ananas\/job\/document\?/);
  const documentDiscovery = content.slice(
    content.indexOf("function getLiveDocumentEntries"),
    content.indexOf("function getFreshDocumentEntry")
  );
  assert.doesNotMatch(documentDiscovery, /data\._jobid|property\._jobid/);
  assert.doesNotMatch(documentDiscovery, /frame\.closest\("\.ans-cc|\[class\*=['"]ans-job/);
  assert.match(documentDiscovery, /const container = frame\.parentElement \|\| frame\.closest\("\.ans-attach-ct"\)/);
  assert.doesNotMatch(content, /driven\.complete \|\| await waitForDocumentCompletion/);
  assert.match(content, /pauseForVerificationConflict/);
  assert.match(content, /直接父容器=/);
  const viewer = read("document-viewer.js");
  assert.match(viewer, /panView\.view\.scrollTo/);
  assert.match(viewer, /new MutationObserver/);
  assert.match(viewer, /image\.addEventListener\("load"/);
  assert.doesNotMatch(viewer, /await wait\(250\)/);
  assert.doesNotMatch(viewer, /container\?\.querySelector\?\.\("\.ans-job-finished"\)/);
}

async function testDocumentCompletionIsolation() {
  const content = read("content.js");
  const makeContainer = (className) => ({
    className,
    classList: {
      contains(name) { return className.split(/\s+/).includes(name); }
    }
  });
  const entries = [
    { jobId: "doc-1", frame: {}, container: makeContainer("ans-attach-ct ans-job-finished") },
    { jobId: "doc-2", frame: {}, container: makeContainer("ans-attach-ct") },
    { jobId: "doc-3", frame: {}, container: makeContainer("ans-attach-ct") }
  ];
  const frames = entries.map((entry, index) => ({
    parentElement: entry.container,
    closest() { throw new Error("direct parents must be used before ancestor lookup"); },
    getAttribute(name) {
      if (name === "jobid") return entry.jobId;
      if (name === "title") return `Document ${index + 1}`;
      return null;
    }
  }));
  entries.forEach((entry, index) => { entry.frame = frames[index]; });
  const discover = vm.runInNewContext(
    `(${extractFunction(content, "getLiveDocumentEntries")})`,
    {
      DOCUMENT_FRAME_SELECTOR: "iframe.document",
      getContentDocument: () => ({ querySelectorAll: () => frames }),
      readFrameData: () => ({}),
      String
    }
  );
  const discovered = discover();
  assert.equal(discovered.length, 3);
  assert.equal(discovered[0].container, entries[0].container);
  assert.equal(discovered[1].container, entries[1].container);
  assert.equal(discovered[2].container, entries[2].container);

  const snapshot = vm.runInNewContext(
    `(${extractFunction(content, "getDocumentCompletionSnapshot")})`,
    { getLiveDocumentEntries: () => entries, String, Boolean }
  );
  assert.equal(snapshot(entries[0]).complete, true, "the first document owns its finished marker");
  assert.equal(snapshot(entries[1]).complete, false, "the second document must ignore its finished sibling");
  assert.equal(snapshot(entries[2]).complete, false, "the third document must ignore its finished sibling");
  assert.equal(snapshot({ jobId: "missing", frame: {} }).missing, true, "a missing live iframe is never complete");

  const duplicates = vm.runInNewContext(
    `(${extractFunction(content, "getDuplicateDocumentJobIds")})`,
    { Map }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(duplicates([...entries, { ...entries[1], frame: {} }]))),
    [{ jobId: "doc-2", count: 2 }]
  );

  const pendingConflict = vm.runInNewContext(
    `(${extractFunction(content, "getPendingTaskConflict")})`,
    {
      isVideoComplete: (entry) => entry.completed,
      isDocumentComplete: (entry) => entry.completed
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(pendingConflict({ videos: [], documents: [{ completed: true }] }, 2))),
    { expectedCount: 2, incompleteCount: 0 }
  );
  assert.equal(
    pendingConflict({ videos: [], documents: [{ completed: false }, { completed: false }] }, 2),
    null
  );
}

async function testWaitHelperReferences() {
  const content = read("content.js");
  const definitions = new Set(
    [...content.matchAll(/(?:async\s+)?function\s+(waitFor[A-Z]\w*)\s*\(/g)]
      .map((match) => match[1])
  );
  const calls = new Set(
    [...content.matchAll(/\b(waitFor[A-Z]\w*)\s*\(/g)]
      .map((match) => match[1])
  );
  const missing = [...calls].filter((name) => !definitions.has(name));
  assert.deepEqual(missing, [], `undefined wait helpers: ${missing.join(", ")}`);
  assert.ok(calls.has("waitForCatalog"), "final verification must use the defined course-catalog wait helper");
}

async function testFinalVerificationEntry() {
  const content = read("content.js");
  const state = { catalog: [], failures: [] };
  let catalogWaits = 0;
  const sandbox = {
    state,
    waitForCatalog: async (token) => {
      assert.equal(token, "run-token");
      catalogWaits += 1;
      return [];
    },
    saveState: async (patch) => Object.assign(state, patch),
    addLog: async () => undefined
  };
  const verifyCatalog = vm.runInNewContext(
    `(${extractFunction(content, "verifyCatalog")})`,
    sandbox
  );
  const result = await verifyCatalog("run-token");
  assert.equal(result, true);
  assert.equal(catalogWaits, 1, "final verification must enter the defined catalog wait helper");
  assert.equal(state.phase, "verifying");
  assert.equal(state.resumePhase, "verifying");
}

async function testStaggeredMediaDiscovery() {
  const content = read("content.js");
  const advance = vm.runInNewContext(`(${extractFunction(content, "advanceMediaStability")})`);
  const meetsExpected = vm.runInNewContext(`(${extractFunction(content, "meetsExpectedPendingTaskCount")})`);
  const shouldReprocess = vm.runInNewContext(`(${extractFunction(content, "shouldReprocessDiscoveredTask")})`);
  let state = { previousSignature: "", quietSince: 0 };
  state = advance(state.previousSignature, state.quietSince, "document:first", 1, 100);
  state = advance(state.previousSignature, state.quietSince, "document:first", 1, 1_000);
  assert.equal(state.quietSince, 100, "an unchanged first document keeps the original quiet-window start");
  assert.ok(1_000 - state.quietSince < 4_000, "the first document alone must not stabilize after one second");

  state = advance(
    state.previousSignature,
    state.quietSince,
    "document:first|document:second|document:third",
    3,
    2_000
  );
  assert.equal(state.quietSince, 2_000, "later document nodes must restart the quiet window");
  assert.ok(5_999 - state.quietSince < 4_000, "the expanded set must remain open until the full quiet window");
  assert.ok(6_000 - state.quietSince >= 4_000, "the complete three-document set may stabilize after four quiet seconds");
  assert.equal(meetsExpected(0, 2), false, "a completed first document cannot satisfy two pending task points");
  assert.equal(meetsExpected(2, 2), true, "all pending task points satisfy the chapter badge");
  assert.equal(meetsExpected(0, null), true, "chapters without a readable badge use the quiet-window fallback");
  assert.equal(shouldReprocess(undefined, { completed: false }), true, "a newly discovered unfinished document returns to processing");
  assert.equal(shouldReprocess({ completed: true }, { completed: false }), true, "a regressed completion state returns to processing");
  assert.equal(shouldReprocess({ completed: false }, { completed: false }), false, "an already-known unfinished task does not create a verification loop");
  assert.equal(shouldReprocess(undefined, { completed: true }), false, "a newly discovered completed task only needs verification");
}

async function testPanelGeometry() {
  const content = read("content.js");
  const clamp = vm.runInNewContext(
    `(${extractFunction(content, "clampPanelPosition")})`,
    { PANEL_MARGIN: 8 }
  );
  const calculate = vm.runInNewContext(
    `(${extractFunction(content, "calculateDraggedPanelPosition")})`,
    { clampPanelPosition: clamp }
  );
  const topLeft = clamp(-200, -100, 240, 52, 1200, 800, 8);
  assert.equal(topLeft.left, 8);
  assert.equal(topLeft.top, 8);
  const bottomRight = clamp(5000, 5000, 240, 52, 1200, 800, 8);
  assert.equal(bottomRight.left, 952);
  assert.equal(bottomRight.top, 740);
  const dragged = calculate(100, 80, 20, 30, 170, 230, 240, 52, 1200, 800);
  assert.equal(dragged.left, 250);
  assert.equal(dragged.top, 280);
  const clampedDrag = calculate(900, 700, 0, 0, 900, 900, 240, 52, 1200, 800);
  assert.equal(clampedDrag.left, 952);
  assert.equal(clampedDrag.top, 740);
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
  const setLayout = await new Promise((resolve) => {
    listener({
      type: "ui:panel:set",
      layout: { collapsed: true, left: 321, top: 123 }
    }, { tab: { id: 1 } }, resolve);
  });
  assert.equal(setLayout.ok, true);
  assert.equal(setLayout.result.collapsed, true);
  assert.equal(setLayout.result.left, 321);
  assert.equal(setLayout.result.top, 123);
  const getLayout = await new Promise((resolve) => {
    listener({ type: "ui:panel:get" }, { tab: { id: 1 } }, resolve);
  });
  assert.equal(getLayout.ok, true);
  assert.equal(getLayout.result.collapsed, true);
  assert.equal(getLayout.result.left, 321);
  assert.equal(getLayout.result.top, 123);
}

(async () => {
  await testManifest();
  await testViewerTraversal();
  await testImplementationMarkers();
  await testDocumentCompletionIsolation();
  await testWaitHelperReferences();
  await testFinalVerificationEntry();
  await testStaggeredMediaDiscovery();
  await testPanelGeometry();
  await testBackgroundNotification();
  console.log("smoke tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
