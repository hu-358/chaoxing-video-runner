(() => {
  "use strict";

  if (window.__CXVU_DOCUMENT_VIEWER_LOADED__) return;
  window.__CXVU_DOCUMENT_VIEWER_LOADED__ = true;

  const PARENT_SOURCE = "cxvu-document-parent-v1";
  const VIEWER_SOURCE = "cxvu-document-viewer-v1";
  const READY_TIMEOUT_MS = 45_000;
  const LAYOUT_TIMEOUT_MS = 60_000;
  let activeRun = 0;
  let activeJobId = "";
  let running = false;

  function post(type, payload = {}) {
    window.top.postMessage({ source: VIEWER_SOURCE, type, ...payload }, "*");
  }

  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function firstNumber(value) {
    const match = String(value || "").match(/\d+/);
    return match ? Number(match[0]) : 0;
  }

  function getFrameJobId() {
    try {
      const frame = window.frameElement;
      const data = JSON.parse(frame?.getAttribute("data") || "{}");
      return String(frame?.getAttribute("jobid") || data.jobid || "");
    } catch {
      return "";
    }
  }

  function getPanView() {
    const frame = document.querySelector("#panView");
    try {
      const view = frame?.contentWindow;
      const frameDocument = view?.document;
      if (!view || !frameDocument?.documentElement) return null;
      return { frame, view, document: frameDocument };
    } catch {
      return null;
    }
  }

  function getPanPages(frameDocument) {
    const anchoredPages = [...frameDocument.querySelectorAll("li[id^='anchor']")];
    return anchoredPages.length > 0 ? anchoredPages : [...frameDocument.querySelectorAll("li")];
  }

  function getScrollingElement(panView) {
    return panView.document.scrollingElement
      || panView.document.documentElement
      || panView.document.body;
  }

  function pageSnapshot() {
    const panView = getPanView();
    if (panView) {
      const pages = getPanPages(panView.document);
      const scrollingElement = getScrollingElement(panView);
      const scrollTop = Number(scrollingElement?.scrollTop || panView.document.body?.scrollTop || 0);
      const viewportHeight = Number(scrollingElement?.clientHeight || panView.view.innerHeight || 0);
      let current = pages.length > 0 ? 1 : 0;
      pages.forEach((page, index) => {
        if (Number(page.offsetTop || 0) <= scrollTop + Math.max(1, viewportHeight / 2)) current = index + 1;
      });
      return { current, total: pages.length };
    }
    const current = firstNumber(document.querySelector(".pageInfo .num, .mkeNum_bom .num, .num")?.textContent);
    const total = firstNumber(document.querySelector(".pageInfo .all, .mkeNum_bom .all, .all")?.textContent);
    return { current, total };
  }

  function clickFinishMask() {
    const mask = document.querySelector("#maskLayer");
    if (!visible(mask)) return false;
    mask.click();
    return true;
  }

  function yieldForBrowserEvents() {
    if (typeof MessageChannel !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close?.();
        channel.port2.close?.();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }

  function viewerReady() {
    const panView = getPanView();
    const panReady = panView && (
      getPanPages(panView.document).length > 0
      || Number(getScrollingElement(panView)?.scrollHeight || 0) > 0
    );
    return Boolean(document.querySelector(".nextBtn") || panReady || visible(document.querySelector("#maskLayer")));
  }

  function waitUntilReady(runId) {
    if (viewerReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let observedFrame = null;
      let panObserver = null;
      let watchdog = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        outerObserver.disconnect();
        panObserver?.disconnect();
        observedFrame?.removeEventListener("load", check);
        resolve(value);
      };
      const attachPanObserver = () => {
        const panView = getPanView();
        if (panView?.frame && panView.frame !== observedFrame) {
          observedFrame?.removeEventListener("load", check);
          observedFrame = panView.frame;
          observedFrame.addEventListener("load", check);
        }
        if (panView?.document?.documentElement && panObserver?.observedDocument !== panView.document) {
          panObserver?.disconnect();
          panObserver = new MutationObserver(check);
          panObserver.observedDocument = panView.document;
          panObserver.observe(panView.document.documentElement, { childList: true, subtree: true, attributes: true });
        }
      };
      function check() {
        if (runId !== activeRun) {
          finish(false);
          return;
        }
        attachPanObserver();
        if (viewerReady()) finish(true);
      }
      const outerObserver = new MutationObserver(check);
      outerObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      watchdog = window.setTimeout(() => finish(viewerReady()), READY_TIMEOUT_MS);
      check();
    });
  }

  function observeOfficialCompletion(jobId) {
    const container = window.frameElement?.parentElement;
    let sent = false;
    const check = () => {
      const complete = Boolean(container?.classList?.contains("ans-job-finished"));
      if (complete && !sent) {
        sent = true;
        post("complete", { jobId });
      }
      return complete;
    };
    const observer = container ? new MutationObserver(check) : null;
    observer?.observe(container, { attributes: true, childList: true, subtree: true });
    check();
    return { check, disconnect: () => observer?.disconnect() };
  }

  function advancePanPages(panView, runId, jobId) {
    return new Promise((resolve, reject) => {
      const watchedImages = new WeakSet();
      const pendingImages = new Set();
      let settled = false;
      let passRunning = false;
      let rerunRequested = false;
      let lastReported = 0;
      let lastTotal = 0;
      let watchdog = 0;

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        observer.disconnect();
        error ? reject(error) : resolve(result);
      };
      const signal = () => {
        if (settled) return;
        if (passRunning) {
          rerunRequested = true;
          return;
        }
        queueMicrotask(runPass);
      };
      const watchImages = () => {
        [...panView.document.images].forEach((image) => {
          if (watchedImages.has(image)) return;
          watchedImages.add(image);
          pendingImages.add(image);
          const done = () => {
            pendingImages.delete(image);
            signal();
          };
          if (!image.complete) {
            image.addEventListener("load", done, { once: true });
            image.addEventListener("error", done, { once: true });
          } else if (typeof image.decode === "function") {
            Promise.resolve(image.decode()).catch(() => undefined).finally(done);
          } else {
            done();
          }
        });
      };
      const traverse = async () => {
        const pages = getPanPages(panView.document);
        const scrollingElement = getScrollingElement(panView);
        const scrollHeight = Number(scrollingElement?.scrollHeight || 0);
        const clientHeight = Number(scrollingElement?.clientHeight || panView.view.innerHeight || 0);
        let total = pages.length;
        if (pages.length > 0) {
          for (let index = 0; index < pages.length; index += 1) {
            const page = pages[index];
            panView.view.scrollTo(0, Math.max(0, Number(page.offsetTop || 0)));
            const current = index + 1;
            if (current > lastReported || total !== lastTotal) {
              post("progress", { jobId, current, total });
              lastReported = current;
              lastTotal = total;
            }
            await yieldForBrowserEvents();
          }
        } else if (scrollHeight > 0 && clientHeight > 0) {
          total = Math.max(1, Math.ceil(scrollHeight / clientHeight));
          for (let current = 1; current <= total; current += 1) {
            panView.view.scrollTo(0, Math.min(scrollHeight, (current - 1) * clientHeight));
            if (current > lastReported || total !== lastTotal) {
              post("progress", { jobId, current, total });
              lastReported = current;
              lastTotal = total;
            }
            await yieldForBrowserEvents();
          }
        }
        panView.view.scrollTo(0, Number(getScrollingElement(panView)?.scrollHeight || scrollHeight));
        return {
          current: total,
          total,
          signature: `${total}:${Number(getScrollingElement(panView)?.scrollHeight || 0)}`
        };
      };
      async function runPass() {
        if (settled || passRunning) return;
        if (runId !== activeRun) {
          finish(new Error("文档阅读已取消"));
          return;
        }
        passRunning = true;
        rerunRequested = false;
        try {
          watchImages();
          const before = await traverse();
          await yieldForBrowserEvents();
          watchImages();
          const after = await traverse();
          await yieldForBrowserEvents();
          if (pendingImages.size === 0 && before.signature === after.signature && after.total > 0) {
            finish(null, { current: after.current, total: after.total });
            return;
          }
        } catch (error) {
          finish(error);
          return;
        } finally {
          passRunning = false;
        }
        if (rerunRequested) queueMicrotask(runPass);
      }

      const observer = new MutationObserver(signal);
      observer.observe(panView.document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      watchdog = window.setTimeout(() => {
        const snapshot = pageSnapshot();
        snapshot.total > 0 ? finish(null, snapshot) : finish(new Error("官方文档页面加载超时"));
      }, LAYOUT_TIMEOUT_MS);
      signal();
    });
  }

  function waitForPageChange(before, runId) {
    if (pageSnapshot().current !== before) return Promise.resolve(pageSnapshot());
    return new Promise((resolve) => {
      let settled = false;
      let watchdog = 0;
      const finish = () => {
        const snapshot = pageSnapshot();
        if (settled || (runId === activeRun && snapshot.current === before)) return;
        settled = true;
        window.clearTimeout(watchdog);
        observer.disconnect();
        resolve(snapshot);
      };
      const observer = new MutationObserver(finish);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      watchdog = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve(pageSnapshot());
      }, 15_000);
    });
  }

  async function advanceButtonPages(runId, jobId) {
    let snapshot = pageSnapshot();
    let safety = Math.min(snapshot.total + 2, 1000);
    while (runId === activeRun && snapshot.current > 0 && snapshot.current < snapshot.total && safety > 0) {
      const next = document.querySelector(".nextBtn");
      if (!visible(next)) break;
      const before = snapshot.current;
      next.click();
      snapshot = await waitForPageChange(before, runId);
      if (snapshot.current === before) throw new Error(`第${before}页后无法继续翻页`);
      post("progress", { jobId, current: snapshot.current, total: snapshot.total });
      safety -= 1;
    }
    return snapshot;
  }

  async function runDocument(jobId) {
    const runId = ++activeRun;
    activeJobId = jobId;
    running = true;
    const completion = observeOfficialCompletion(jobId);
    post("started", { jobId });
    try {
      if (!(await waitUntilReady(runId))) throw new Error("官方文档查看器加载超时");
      const opened = clickFinishMask();
      const panView = getPanView();
      const pages = panView
        ? await advancePanPages(panView, runId, jobId)
        : await advanceButtonPages(runId, jobId);
      const closed = clickFinishMask();
      await yieldForBrowserEvents();
      if (!opened && !closed && !pages.total) throw new Error("未找到官方文档分页区域");
      if (!completion.check()) {
        post("traversed", { jobId, opened: opened || closed, current: pages.current, total: pages.total });
      }
    } catch (error) {
      if (runId === activeRun) post("error", { jobId, message: error?.message || String(error) });
    } finally {
      completion.disconnect();
      if (runId === activeRun) running = false;
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if ((event.source !== window.top && event.source !== window.parent)
      || message?.source !== PARENT_SOURCE
      || message.type !== "start") return;
    const jobId = String(message.jobId || "");
    if (!jobId || (running && activeJobId === jobId)) return;
    void runDocument(jobId);
  });

  post("ready", { jobId: getFrameJobId(), href: window.location.href });
})();
