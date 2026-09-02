(() => {
  "use strict";

  if (window.__CXVU_DOCUMENT_VIEWER_LOADED__) {
    return;
  }
  window.__CXVU_DOCUMENT_VIEWER_LOADED__ = true;

  const PARENT_SOURCE = "cxvu-document-parent-v1";
  const VIEWER_SOURCE = "cxvu-document-viewer-v1";
  let activeRun = 0;
  let activeJobId = "";
  let running = false;

  function post(type, payload = {}) {
    window.top.postMessage({ source: VIEWER_SOURCE, type, ...payload }, "*");
  }

  function visible(element) {
    if (!element?.isConnected) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function firstNumber(value) {
    const match = String(value || "").match(/\d+/);
    return match ? Number(match[0]) : 0;
  }

  function pageSnapshot() {
    const panView = getPanView();
    if (panView) {
      const pages = getPanPages(panView.document);
      const scrollingElement = panView.document.scrollingElement
        || panView.document.documentElement
        || panView.document.body;
      const scrollTop = Number(scrollingElement?.scrollTop || panView.document.body?.scrollTop || 0);
      const viewportHeight = Number(scrollingElement?.clientHeight || panView.view.innerHeight || 0);
      let current = pages.length > 0 ? 1 : 0;
      pages.forEach((page, index) => {
        if (Number(page.offsetTop || 0) <= scrollTop + Math.max(1, viewportHeight / 2)) {
          current = index + 1;
        }
      });
      return { current, total: pages.length };
    }
    const current = firstNumber(document.querySelector(".pageInfo .num, .mkeNum_bom .num, .num")?.textContent);
    const total = firstNumber(document.querySelector(".pageInfo .all, .mkeNum_bom .all, .all")?.textContent);
    return { current, total };
  }

  function getPanView() {
    const frame = document.querySelector("#panView");
    try {
      const view = frame?.contentWindow;
      const frameDocument = view?.document;
      if (!view || !frameDocument?.documentElement) {
        return null;
      }
      return { frame, view, document: frameDocument };
    } catch {
      return null;
    }
  }

  function getPanPages(frameDocument) {
    const anchoredPages = [...frameDocument.querySelectorAll("li[id^='anchor']")];
    return anchoredPages.length > 0 ? anchoredPages : [...frameDocument.querySelectorAll("li")];
  }

  function clickFinishMask() {
    const mask = document.querySelector("#maskLayer");
    if (!visible(mask)) {
      return false;
    }
    mask.click();
    return true;
  }

  async function wait(ms) {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function waitUntilReady(runId) {
    const deadline = Date.now() + 30_000;
    while (runId === activeRun && Date.now() < deadline) {
      const container = document.querySelector("#docContainer");
      const next = document.querySelector(".nextBtn");
      const panView = getPanView();
      const panReady = panView && (
        getPanPages(panView.document).length > 0
        || Number(panView.document.documentElement?.scrollHeight || 0) > 0
      );
      if ((container || panView) && (next || panReady || visible(document.querySelector("#maskLayer")))) {
        return true;
      }
      await wait(300);
    }
    return false;
  }

  async function advancePages(runId, jobId) {
    const panView = getPanView();
    if (panView) {
      const pages = getPanPages(panView.document);
      const scrollingElement = panView.document.scrollingElement
        || panView.document.documentElement
        || panView.document.body;
      if (pages.length > 0) {
        for (let index = 0; runId === activeRun && index < pages.length; index += 1) {
          panView.view.scrollTo(0, Math.max(0, Number(pages[index].offsetTop || 0)));
          post("progress", { jobId, current: index + 1, total: pages.length });
          await wait(250);
        }
        panView.view.scrollTo(0, Number(scrollingElement?.scrollHeight || pages.at(-1)?.offsetTop || 0));
        await wait(800);
        return { current: pages.length, total: pages.length };
      }

      const scrollHeight = Number(scrollingElement?.scrollHeight || 0);
      const clientHeight = Number(scrollingElement?.clientHeight || panView.view.innerHeight || 0);
      if (scrollHeight > 0 && clientHeight > 0) {
        const total = Math.max(1, Math.ceil(scrollHeight / clientHeight));
        for (let current = 1; runId === activeRun && current <= total; current += 1) {
          panView.view.scrollTo(0, Math.min(scrollHeight, (current - 1) * clientHeight));
          post("progress", { jobId, current, total });
          await wait(250);
        }
        panView.view.scrollTo(0, scrollHeight);
        await wait(800);
        return { current: total, total };
      }
    }

    let snapshot = pageSnapshot();
    if (!snapshot.total || snapshot.total <= 1) {
      return snapshot;
    }

    let safety = Math.min(snapshot.total + 2, 1000);
    while (runId === activeRun && snapshot.current > 0 && snapshot.current < snapshot.total && safety > 0) {
      const next = document.querySelector(".nextBtn");
      if (!visible(next)) {
        break;
      }
      const before = snapshot.current;
      next.click();
      const deadline = Date.now() + 10_000;
      do {
        await wait(250);
        snapshot = pageSnapshot();
      } while (runId === activeRun && snapshot.current === before && Date.now() < deadline);
      if (snapshot.current === before) {
        throw new Error(`第${before}页后无法继续翻页`);
      }
      post("progress", { jobId, current: snapshot.current, total: snapshot.total });
      await wait(1000);
      safety -= 1;
    }
    return snapshot;
  }

  async function runDocument(jobId) {
    const runId = ++activeRun;
    activeJobId = jobId;
    running = true;
    post("started", { jobId });
    try {
      if (!(await waitUntilReady(runId))) {
        throw new Error("官方文档查看器加载超时");
      }
      const opened = clickFinishMask();
      await wait(800);
      const pages = await advancePages(runId, jobId);
      const closed = clickFinishMask();
      if (!opened && !closed && !pages.total) {
        throw new Error("未找到官方文档分页区域");
      }
      post("traversed", { jobId, opened: opened || closed, current: pages.current, total: pages.total });
    } catch (error) {
      if (runId === activeRun) {
        post("error", { jobId, message: error?.message || String(error) });
      }
    } finally {
      if (runId === activeRun) {
        running = false;
      }
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if ((event.source !== window.top && event.source !== window.parent)
      || message?.source !== PARENT_SOURCE
      || message.type !== "start") {
      return;
    }
    const jobId = String(message.jobId || "");
    if (!jobId || (running && activeJobId === jobId)) {
      return;
    }
    void runDocument(jobId);
  });

  post("ready", { href: window.location.href });
})();
