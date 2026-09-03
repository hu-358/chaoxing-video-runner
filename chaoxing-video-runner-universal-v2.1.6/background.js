"use strict";

const REGISTRY_KEY = "cxvu_registry_v1";
const COURSE_PREFIX = "cxvu_course_v1_";
const LOCK_PREFIX = "cxvu_lock_v1_";
const PANEL_UI_KEY = "cxvu_panel_ui_v1";
const LOCK_TTL_MS = 20_000;
let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

function storageGet(key) {
  return chrome.storage.local.get(key).then((result) => result[key]);
}

function storageSet(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

function courseStateKey(courseKey) {
  return `${COURSE_PREFIX}${courseKey}`;
}

function courseLockKey(courseKey) {
  return `${LOCK_PREFIX}${courseKey}`;
}

async function updateRegistry(metadata, state) {
  const registry = (await storageGet(REGISTRY_KEY)) || { schema: 1, courses: {} };
  const previous = registry.courses[metadata.courseKey] || {};
  const fallbackName = `课程 ${metadata.courseId}`;
  const incomingName = metadata.name || "";
  const resolvedName = incomingName && incomingName !== fallbackName
    ? incomingName
    : previous.name || fallbackName;
  registry.courses[metadata.courseKey] = {
    ...previous,
    courseKey: metadata.courseKey,
    courseId: metadata.courseId,
    clazzId: metadata.clazzId,
    name: resolvedName,
    phase: state?.phase ?? previous.phase ?? "idle",
    status: state?.status ?? previous.status ?? "已识别",
    running: state?.running ?? previous.running ?? false,
    completed: state?.completed ?? previous.completed ?? 0,
    total: state?.total ?? previous.total ?? 0,
    videoCompleted: state?.videoCompleted ?? previous.videoCompleted ?? 0,
    videoTotal: state?.videoTotal ?? previous.videoTotal ?? 0,
    documentCompleted: state?.documentCompleted ?? previous.documentCompleted ?? 0,
    documentTotal: state?.documentTotal ?? previous.documentTotal ?? 0,
    failures: state?.failures?.length ?? previous.failures ?? 0,
    speedMode: state?.speedMode ?? previous.speedMode ?? "auto",
    updatedAt: Date.now()
  };
  await storageSet(REGISTRY_KEY, registry);
  return registry.courses[metadata.courseKey];
}

async function handleMessage(message, sender) {
  const courseKey = message.courseKey;
  switch (message.type) {
    case "course:register": {
      return updateRegistry(message.metadata, message.state || null);
    }
    case "courses:list": {
      const registry = (await storageGet(REGISTRY_KEY)) || { schema: 1, courses: {} };
      return Object.values(registry.courses || {}).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    case "state:get": {
      return (await storageGet(courseStateKey(courseKey))) || null;
    }
    case "state:replace": {
      await storageSet(courseStateKey(courseKey), message.state);
      await updateRegistry(message.metadata, message.state);
      return message.state;
    }
    case "ui:panel:get": {
      return (await storageGet(PANEL_UI_KEY)) || { collapsed: false, left: null, top: null };
    }
    case "ui:panel:set": {
      const layout = {
        collapsed: Boolean(message.layout?.collapsed),
        left: Number.isFinite(message.layout?.left) ? Number(message.layout.left) : null,
        top: Number.isFinite(message.layout?.top) ? Number(message.layout.top) : null
      };
      await storageSet(PANEL_UI_KEY, layout);
      return layout;
    }
    case "lock:acquire": {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) {
        return { acquired: false, reason: "无法识别当前标签页" };
      }
      const key = courseLockKey(courseKey);
      const lock = await storageGet(key);
      const now = Date.now();
      if (lock && lock.tabId !== tabId && lock.expiresAt > now) {
        return { acquired: false, reason: "同一课程已在另一个标签页运行" };
      }
      const nextLock = { tabId, expiresAt: now + LOCK_TTL_MS };
      await storageSet(key, nextLock);
      return { acquired: true, expiresAt: nextLock.expiresAt };
    }
    case "lock:heartbeat": {
      const tabId = sender.tab?.id;
      const key = courseLockKey(courseKey);
      const lock = await storageGet(key);
      if (!lock || lock.tabId !== tabId) {
        return { acquired: false };
      }
      lock.expiresAt = Date.now() + LOCK_TTL_MS;
      await storageSet(key, lock);
      return { acquired: true, expiresAt: lock.expiresAt };
    }
    case "lock:release": {
      const tabId = sender.tab?.id;
      const key = courseLockKey(courseKey);
      const lock = await storageGet(key);
      if (lock?.tabId === tabId) {
        await chrome.storage.local.remove(key);
      }
      return { released: true };
    }
    case "notification:show": {
      const notificationId = `cxvu-${courseKey || "global"}-${Date.now()}`;
      await chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon-128.png"),
        title: String(message.title || "学习通课程任务播放器"),
        message: String(message.message || "任务状态已更新"),
        priority: message.priority === 2 ? 2 : 0
      });
      return { notificationId };
    }
    default:
      throw new Error(`未知消息类型：${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handleMessage(message, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
