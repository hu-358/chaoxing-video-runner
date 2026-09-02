(() => {
  "use strict";

  if (window.top !== window.self || window.__CXVU_LOADED__) {
    return;
  }
  window.__CXVU_LOADED__ = true;

  const pageParams = new URL(window.location.href).searchParams;
  const COURSE_ID = pageParams.get("courseId") || pageParams.get("courseid");
  const CLAZZ_ID = pageParams.get("clazzid") || pageParams.get("clazzId");
  if (!COURSE_ID || !CLAZZ_ID) {
    return;
  }

  const COURSE_KEY = `${COURSE_ID}:${CLAZZ_ID}`;
  const CONFIG = Object.freeze({
    appVersion: chrome.runtime.getManifest().version,
    maxRetries: 5,
    retryDelayMs: 10_000,
    catalogWaitMs: 60_000,
    navigationWaitMs: 60_000,
    videoFrameWaitMs: 30_000,
    scanNoVideoStableMs: 4_000,
    stallTimeoutMs: 30_000,
    completionWaitMs: 45_000,
    maxLogs: 300
  });
  const OBVIOUS_NON_VIDEO = /(测试|测验|考试|作业|讨论|问卷)/;
  const BLOCKER_TEXT = /(人脸识别|人脸验证|活体检测|身份验证|请输入验证码|完成验证码|禁止切屏|请勿切换页面|请先完成验证)/;

  let state = makeFreshState();
  let runToken = 0;
  let loopActive = false;
  let panel = null;
  let lastLockHeartbeatAt = 0;
  let globalListTimer = 0;

  function makeFreshState(name = `课程 ${COURSE_ID}`) {
    return {
      schema: 1,
      appVersion: CONFIG.appVersion,
      courseKey: COURSE_KEY,
      courseId: COURSE_ID,
      clazzId: CLAZZ_ID,
      name,
      running: false,
      phase: "idle",
      resumePhase: "scanning",
      status: "待机",
      speedMode: "auto",
      selectedRate: 1,
      catalog: [],
      catalogComplete: false,
      scanIndex: 0,
      scanTotal: 0,
      completed: 0,
      total: 0,
      currentLessonId: "",
      currentLessonTitle: "",
      currentJobId: "",
      currentVideoName: "",
      currentVideoIndex: 0,
      currentVideoCount: 0,
      currentTime: 0,
      duration: 0,
      verificationStartedAt: 0,
      retries: {},
      skippedJobIds: [],
      failures: [],
      logs: [],
      startedAt: null,
      updatedAt: Date.now()
    };
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "扩展后台没有响应"));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function metadata() {
    return {
      courseKey: COURSE_KEY,
      courseId: COURSE_ID,
      clazzId: CLAZZ_ID,
      name: state.name || `课程 ${COURSE_ID}`
    };
  }

  async function saveState(patch = {}) {
    state = { ...state, ...patch, updatedAt: Date.now() };
    await send({
      type: "state:replace",
      courseKey: COURSE_KEY,
      metadata: metadata(),
      state
    });
    renderPanel();
  }

  async function addLog(message, level = "info") {
    const entry = {
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
      level,
      message
    };
    await saveState({ logs: [...(state.logs || []), entry].slice(-CONFIG.maxLogs) });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function parseLessonId(element) {
    const rowId = element.closest(".posCatalog_select")?.id || "";
    if (/^cur\d+$/.test(rowId)) {
      return rowId.replace(/^cur/, "");
    }
    const onclick = element.getAttribute("onclick") || "";
    const numbers = [...onclick.matchAll(/['\"](\d+)['\"]/g)].map((match) => match[1]);
    return numbers.at(-1) || "";
  }

  function getLessonItems() {
    const rows = [...document.querySelectorAll(".posCatalog_select")];
    if (rows.length === 0) {
      document.querySelectorAll(".posCatalog_name[onclick*='getTeacherAjax']").forEach((nameElement) => {
        const row = nameElement.closest("li") || nameElement.parentElement;
        if (row && !rows.includes(row)) {
          rows.push(row);
        }
      });
    }
    return rows.flatMap((row, order) => {
      if (row.classList.contains("firstLayer")) {
        return [];
      }
      const nameElement = row.querySelector(".posCatalog_name");
      const sectionElement = row.querySelector(".posCatalog_sbar");
      if (!nameElement || !sectionElement) {
        return [];
      }
      const lessonId = parseLessonId(nameElement);
      if (!lessonId) {
        return [];
      }
      const title = (nameElement.getAttribute("title") || nameElement.textContent || "").trim();
      return [{
        row,
        nameElement,
        order,
        lessonId,
        section: (sectionElement.textContent || "").trim(),
        title,
        obviousNonVideo: OBVIOUS_NON_VIDEO.test(title)
      }];
    });
  }

  function getCurrentLessonId() {
    const active = document.querySelector(".posCatalog_select.posCatalog_active:not(.firstLayer)");
    const activeId = (active?.id || "").replace(/^cur/, "");
    if (activeId) {
      return activeId;
    }
    return new URL(window.location.href).searchParams.get("chapterId") || "";
  }

  function getContentDocument() {
    try {
      return document.querySelector("iframe#iframe")?.contentDocument || null;
    } catch {
      return null;
    }
  }

  function readFrameData(frame) {
    try {
      return JSON.parse(frame.getAttribute("data") || "{}");
    } catch {
      return {};
    }
  }

  function getLiveVideoEntries() {
    const contentDocument = getContentDocument();
    if (!contentDocument) {
      return [];
    }
    return [...contentDocument.querySelectorAll("iframe.ans-insertvideo-online")].map((frame, index) => {
      const data = readFrameData(frame);
      const container = frame.closest(".videoContainer") || frame.parentElement;
      const jobId = String(
        frame.getAttribute("jobid")
        || data.jobid
        || data._jobid
        || frame.getAttribute("objectid")
        || `${getCurrentLessonId()}-video-${index}`
      );
      return {
        frame,
        container,
        jobId,
        name: data.name || `视频 ${index + 1}`,
        index
      };
    });
  }

  function getFreshVideoEntry(entry) {
    return getLiveVideoEntries().find((candidate) => candidate.jobId === entry.jobId) || entry;
  }

  function getCompletionSnapshot(entry) {
    const fresh = getFreshVideoEntry(entry);
    const containers = [...new Set([fresh.container, entry.container].filter(Boolean))];
    const icons = containers.flatMap((container) => [...container.querySelectorAll(".ans-job-icon")]);
    const completedByContainer = containers.some((container) =>
      container.classList.contains("ans-job-finished")
      || container.querySelector(".ans-job-finished") !== null
    );
    const completedByIcon = icons.some((icon) => {
      const evidence = [
        icon.getAttribute("aria-label") || "",
        icon.getAttribute("title") || "",
        icon.textContent || ""
      ].join(" ");
      return evidence.includes("任务点已完成")
        || evidence.includes("已完成")
        || icon.classList.contains("ans-job-finished")
        || icon.classList.contains("ans-job-icon-finished");
    });
    return {
      complete: completedByContainer || completedByIcon,
      containerClasses: containers.map((container) => container.className).filter(Boolean),
      iconLabels: icons.map((icon) => icon.getAttribute("aria-label") || "").filter(Boolean)
    };
  }

  function isVideoComplete(entry) {
    return getCompletionSnapshot(entry).complete;
  }

  function isVisible(element) {
    if (!element?.isConnected) {
      return false;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function getInspectableDocuments() {
    const documents = [document];
    const contentDocument = getContentDocument();
    if (contentDocument) {
      documents.push(contentDocument);
      getLiveVideoEntries().forEach((entry) => {
        try {
          if (entry.frame.contentDocument) {
            documents.push(entry.frame.contentDocument);
          }
        } catch {
          // Ignore a video frame that is currently navigating.
        }
      });
    }
    return [...new Set(documents)];
  }

  function detectManualBlocker() {
    const highSignalSelector = [
      "input[placeholder*='验证码']",
      "img[src*='captcha']",
      "[class*='captcha']",
      "[id*='captcha']",
      "[class*='face-recognition']",
      "[class*='faceRecognition']",
      "[id*='faceRecognition']"
    ].join(",");
    const dialogSelector = "[role='dialog'],.layui-layer,.el-dialog,.modal,.dialog,.pop-up,.popup";

    for (const inspectedDocument of getInspectableDocuments()) {
      const signal = [...inspectedDocument.querySelectorAll(highSignalSelector)].find(isVisible);
      if (signal) {
        return (signal.textContent || signal.getAttribute("placeholder") || "检测到人工验证").trim();
      }
      for (const dialog of inspectedDocument.querySelectorAll(dialogSelector)) {
        const text = (dialog.innerText || "").trim();
        if (isVisible(dialog) && BLOCKER_TEXT.test(text)) {
          return text.slice(0, 160);
        }
      }
    }
    return "";
  }

  async function stopForBlocker(blocker) {
    runToken += 1;
    pauseEveryVideo();
    await saveState({
      running: false,
      resumePhase: state.phase,
      phase: "blocked",
      status: `需要人工处理：${blocker}`
    });
    await addLog(`检测到人工验证，本课程已停止：${blocker}`, "error");
    await releaseLock();
  }

  function pauseEveryVideo() {
    getLiveVideoEntries().forEach((entry) => {
      try {
        entry.frame.contentDocument?.querySelector("video")?.pause();
      } catch {
        // Ignore a frame that is reloading.
      }
    });
  }

  function hasLegacyExtensionConflict() {
    return document.getElementById("cxvr-panel-host") !== null;
  }

  async function acquireLock() {
    return send({ type: "lock:acquire", courseKey: COURSE_KEY });
  }

  async function acquireLockWithWait(waitMs = 25_000) {
    const deadline = Date.now() + waitMs;
    let result = null;
    do {
      result = await acquireLock();
      if (result?.acquired) {
        return result;
      }
      await sleep(1000);
    } while (Date.now() < deadline);
    return result;
  }

  async function releaseLock() {
    lastLockHeartbeatAt = 0;
    return send({ type: "lock:release", courseKey: COURSE_KEY }).catch(() => undefined);
  }

  async function refreshLockIfNeeded() {
    if (Date.now() - lastLockHeartbeatAt < 5000) {
      return true;
    }
    lastLockHeartbeatAt = Date.now();
    const result = await send({ type: "lock:heartbeat", courseKey: COURSE_KEY });
    return result?.acquired === true;
  }

  async function ensureRunConditions(token) {
    if (token !== runToken || !state.running) {
      return false;
    }
    if (!(await refreshLockIfNeeded())) {
      state = { ...state, running: false, phase: "observer", status: "同一课程已由另一个标签页接管" };
      renderPanel();
      return false;
    }
    const blocker = detectManualBlocker();
    if (blocker) {
      await stopForBlocker(blocker);
      return false;
    }
    return true;
  }

  async function waitForCatalog(token) {
    const deadline = Date.now() + CONFIG.catalogWaitMs;
    let previousCount = -1;
    let stablePolls = 0;
    while (Date.now() < deadline && await ensureRunConditions(token)) {
      const items = getLessonItems();
      if (items.length > 0 && items.length === previousCount) {
        stablePolls += 1;
      } else {
        previousCount = items.length;
        stablePolls = 0;
      }
      if (items.length > 0 && stablePolls >= 2) {
        return items;
      }
      await saveState({ status: "正在等待课程目录加载" });
      await sleep(1000);
    }
    return [];
  }

  async function navigateToLesson(lesson, token) {
    if (!(await ensureRunConditions(token))) {
      return false;
    }
    const latest = getLessonItems().find((item) => item.lessonId === lesson.lessonId);
    if (!latest) {
      return false;
    }
    await saveState({
      currentLessonId: lesson.lessonId,
      currentLessonTitle: `${lesson.section} ${lesson.title}`,
      status: `正在打开 ${lesson.section} ${lesson.title}`
    });
    latest.nameElement.click();

    const deadline = Date.now() + CONFIG.navigationWaitMs;
    while (Date.now() < deadline && await ensureRunConditions(token)) {
      const contentDocument = getContentDocument();
      if (getCurrentLessonId() === lesson.lessonId && contentDocument?.body?.children.length) {
        await sleep(1200);
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  async function waitForStableVideoEntries(token, scanning = false) {
    const deadline = Date.now() + (scanning ? 15_000 : CONFIG.videoFrameWaitMs);
    let zeroReadySince = 0;
    let previousCount = -1;
    let stablePolls = 0;

    while (Date.now() < deadline && await ensureRunConditions(token)) {
      const contentDocument = getContentDocument();
      const entries = getLiveVideoEntries();
      if (entries.length > 0 && entries.length === previousCount) {
        stablePolls += 1;
      } else {
        previousCount = entries.length;
        stablePolls = 0;
      }
      if (entries.length > 0 && stablePolls >= 2) {
        return entries;
      }
      if (scanning && contentDocument?.readyState === "complete" && entries.length === 0) {
        zeroReadySince ||= Date.now();
        if (Date.now() - zeroReadySince >= CONFIG.scanNoVideoStableMs) {
          return [];
        }
      } else {
        zeroReadySince = 0;
      }
      await sleep(500);
    }
    return getLiveVideoEntries();
  }

  function summarizeLiveVideos(entries) {
    return entries.map((entry) => ({
      jobId: entry.jobId,
      name: entry.name,
      completed: isVideoComplete(entry),
      verifiedAt: Date.now()
    }));
  }

  function catalogProgress(catalog = state.catalog) {
    const videos = (catalog || []).flatMap((lesson) => lesson.videos || []);
    return {
      total: videos.length,
      completed: videos.filter((video) => video.completed).length
    };
  }

  async function saveCatalog(catalog, patch = {}) {
    const progress = catalogProgress(catalog);
    await saveState({ catalog, total: progress.total, completed: progress.completed, ...patch });
  }

  async function recordScanFailure(lesson, reason) {
    const failureId = `lesson:${lesson.lessonId}`;
    const failures = [
      ...(state.failures || []).filter((failure) => failure.jobId !== failureId),
      { jobId: failureId, name: `${lesson.title}（章节扫描失败）`, lesson: lesson.title, reason, retries: CONFIG.maxRetries }
    ];
    await saveState({ failures });
    await addLog(`扫描失败并跳过章节：${lesson.section} ${lesson.title}；${reason}`, "error");
  }

  async function scanOneLesson(lesson, token) {
    for (let retry = 0; retry <= CONFIG.maxRetries; retry += 1) {
      if (!(await ensureRunConditions(token))) {
        return null;
      }
      const opened = getCurrentLessonId() === lesson.lessonId
        ? true
        : await navigateToLesson(lesson, token);
      if (opened) {
        const entries = await waitForStableVideoEntries(token, true);
        if (!(await ensureRunConditions(token))) {
          return null;
        }
        return summarizeLiveVideos(entries);
      }
      if (retry < CONFIG.maxRetries) {
        await addLog(`章节打开失败，10秒后重试 ${retry + 1}/${CONFIG.maxRetries}：${lesson.title}`, "warn");
        await sleep(CONFIG.retryDelayMs);
      }
    }
    await recordScanFailure(lesson, "多次打开章节超时");
    return [];
  }

  async function scanCourse(token) {
    const allItems = await waitForCatalog(token);
    if (!(await ensureRunConditions(token))) {
      return false;
    }
    if (allItems.length === 0) {
      throw new Error("课程目录加载超时");
    }

    const candidates = allItems.filter((item) => !item.obviousNonVideo);
    const catalog = [];
    await saveState({ scanTotal: candidates.length, scanIndex: 0, status: "开始扫描课程视频" });
    await addLog(`发现${allItems.length}个叶子章节，其中${candidates.length}个需要检查视频。`, "success");

    for (let index = 0; index < candidates.length; index += 1) {
      if (!(await ensureRunConditions(token))) {
        return false;
      }
      const lesson = candidates[index];
      await saveState({
        scanIndex: index + 1,
        currentLessonId: lesson.lessonId,
        currentLessonTitle: `${lesson.section} ${lesson.title}`,
        status: `扫描章节 ${index + 1}/${candidates.length}`
      });
      const videos = await scanOneLesson(lesson, token);
      if (videos === null) {
        return false;
      }
      if (videos.length > 0) {
        catalog.push({
          lessonId: lesson.lessonId,
          section: lesson.section,
          title: lesson.title,
          order: lesson.order,
          videos
        });
        await saveCatalog(catalog);
        await addLog(`已扫描 ${lesson.section} ${lesson.title}：${videos.length}个视频`);
      }
    }

    await saveCatalog(catalog, {
      catalogComplete: true,
      phase: "playing",
      resumePhase: "playing",
      status: `扫描完成：${catalogProgress(catalog).total}个视频`
    });
    await addLog(`课程扫描完成：共发现${catalogProgress(catalog).total}个视频任务。`, "success");
    return true;
  }

  function selectOfficialRate(items) {
    const options = items
      .map((item) => {
        const match = (item.textContent || "").trim().match(/^(\d+(?:\.\d+)?)x/i);
        return match ? { item, rate: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.rate - b.rate);
    if (options.length === 0) {
      return null;
    }
    if (state.speedMode === "auto") {
      return options.at(-1);
    }
    const ceiling = Number(state.speedMode);
    return options.filter((option) => option.rate <= ceiling).at(-1) || options[0];
  }

  async function chooseOfficialRate(doc, video, token, waitMs = 20_000) {
    const deadline = Date.now() + waitMs;
    let openedMenu = false;
    while (Date.now() < deadline && await ensureRunConditions(token)) {
      const menuItems = [...doc.querySelectorAll(".vjs-playback-rate .vjs-menu-item")];
      const selected = selectOfficialRate(menuItems);
      if (selected) {
        if (!selected.item.classList.contains("vjs-selected") || video.playbackRate !== selected.rate) {
          selected.item.click();
        }
        video.defaultPlaybackRate = selected.rate;
        video.playbackRate = selected.rate;
        await saveState({ selectedRate: selected.rate });
        return selected.rate;
      }
      if (!openedMenu) {
        doc.querySelector(".vjs-playback-rate .vjs-menu-button, .vjs-playback-rate button")?.click();
        openedMenu = true;
      }
      await sleep(250);
    }
    throw new Error("等待20秒后仍未加载播放器官方倍速菜单");
  }

  async function waitForVideoElement(entry, token) {
    const deadline = Date.now() + CONFIG.videoFrameWaitMs;
    while (Date.now() < deadline && await ensureRunConditions(token)) {
      const fresh = getFreshVideoEntry(entry);
      try {
        const doc = fresh.frame.contentDocument;
        const video = doc?.querySelector("video");
        if (doc && video) {
          return { entry: fresh, doc, video };
        }
      } catch {
        // Frame is still loading.
      }
      await sleep(500);
    }
    return null;
  }

  async function rewindAndPlay(entry, token) {
    const media = await waitForVideoElement(entry, token);
    if (!media) {
      throw new Error("等待视频播放器加载超时");
    }
    const { doc, video } = media;
    video.muted = true;
    video.volume = 0;
    await video.play();
    let selectedRate = await chooseOfficialRate(doc, video, token);

    const metadataDeadline = Date.now() + 20_000;
    while ((!Number.isFinite(video.duration) || video.duration <= 0) && Date.now() < metadataDeadline) {
      if (!(await ensureRunConditions(token))) {
        throw new Error("运行已暂停");
      }
      await sleep(500);
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = 0;
    }
    video.muted = true;
    video.volume = 0;
    selectedRate = await chooseOfficialRate(doc, video, token);
    await video.play();
    return { video, selectedRate };
  }

  async function waitForCompletion(entry, token, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && await ensureRunConditions(token)) {
      if (isVideoComplete(entry)) {
        return true;
      }
      const seconds = Math.ceil((deadline - Date.now()) / 1000);
      if (seconds % 5 === 0) {
        await saveState({ status: `视频已播完，等待平台确认（最多${seconds}秒）` });
      }
      await sleep(1000);
    }
    return isVideoComplete(entry);
  }

  async function monitorPlayback(entry, media, token) {
    const { video } = media;
    let selectedRate = media.selectedRate;
    let lastTime = -1;
    let lastProgressAt = Date.now();
    let lastSavedAt = 0;
    let lastRateCheckAt = 0;

    while (await ensureRunConditions(token)) {
      if (isVideoComplete(entry)) {
        video.pause();
        return { complete: true, reason: "任务点已完成" };
      }
      if (!video.isConnected) {
        return { complete: false, reason: "播放器页面已刷新" };
      }
      if (video.error) {
        return { complete: false, reason: `媒体错误 ${video.error.code || "未知"}` };
      }

      video.muted = true;
      video.volume = 0;
      if (Date.now() - lastRateCheckAt >= 5000) {
        lastRateCheckAt = Date.now();
        const desired = selectOfficialRate([...video.ownerDocument.querySelectorAll(".vjs-playback-rate .vjs-menu-item")]);
        if (!desired || video.playbackRate !== desired.rate || desired.rate !== selectedRate) {
          selectedRate = await chooseOfficialRate(video.ownerDocument, video, token, 5000);
        }
      }
      if (video.paused && !video.ended) {
        await video.play().catch(() => undefined);
      }

      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (currentTime > lastTime + 0.25) {
        lastTime = currentTime;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastSavedAt >= 5000) {
        lastSavedAt = Date.now();
        await saveState({ currentTime, duration, selectedRate });
      }

      const reachedEnd = video.ended || (duration > 0 && currentTime >= duration - 0.5);
      if (reachedEnd) {
        const complete = await waitForCompletion(entry, token, CONFIG.completionWaitMs);
        if (complete) {
          return { complete: true, reason: "播放结束且任务点已完成" };
        }
        if (token !== runToken || !state.running) {
          return { complete: false, paused: true, reason: "运行已暂停" };
        }
        return { complete: false, reason: "播放结束但任务点仍未完成" };
      }
      if (Date.now() - lastProgressAt >= CONFIG.stallTimeoutMs) {
        return { complete: false, reason: "播放进度连续30秒未前进" };
      }
      await sleep(2000);
    }
    video.pause();
    return { complete: false, paused: true, reason: "运行已暂停" };
  }

  function updateCatalogVideo(jobId, patch) {
    return (state.catalog || []).map((lesson) => ({
      ...lesson,
      videos: (lesson.videos || []).map((video) => video.jobId === jobId ? { ...video, ...patch } : video)
    }));
  }

  async function markVideoCompleted(jobId) {
    const catalog = updateCatalogVideo(jobId, { completed: true, verifiedAt: Date.now() });
    const failures = (state.failures || []).filter((failure) => failure.jobId !== jobId);
    await saveCatalog(catalog, { failures });
  }

  async function handleUnavailableTarget(video, lesson, reason) {
    let retries = Number(state.retries?.[video.jobId] || 0);
    if (retries >= CONFIG.maxRetries) {
      const skippedJobIds = [...new Set([...(state.skippedJobIds || []), video.jobId])];
      const failures = [
        ...(state.failures || []).filter((failure) => failure.jobId !== video.jobId),
        { jobId: video.jobId, name: video.name, lesson: lesson.title, reason, retries }
      ];
      await saveState({ skippedJobIds, failures });
      await addLog(`超过${CONFIG.maxRetries}次重试上限，已跳过：${video.name}；${reason}`, "error");
      return;
    }
    retries += 1;
    await saveState({
      retries: { ...(state.retries || {}), [video.jobId]: retries },
      status: `10秒后重试加载视频（${retries}/${CONFIG.maxRetries}）`
    });
    await addLog(`${video.name}：${reason}，10秒后重试 ${retries}/${CONFIG.maxRetries}`, "warn");
    await sleep(CONFIG.retryDelayMs);
  }

  async function playOneVideo(entry, lesson, videoIndex, token) {
    if (isVideoComplete(entry)) {
      await markVideoCompleted(entry.jobId);
      return;
    }
    let retries = Number(state.retries?.[entry.jobId] || 0);
    while (await ensureRunConditions(token)) {
      await saveState({
        currentJobId: entry.jobId,
        currentVideoName: entry.name,
        currentVideoIndex: videoIndex + 1,
        currentVideoCount: lesson.videos.length,
        currentTime: 0,
        duration: 0,
        status: retries === 0 ? "正在播放" : `正在进行第${retries}/${CONFIG.maxRetries}次重试`
      });
      try {
        await addLog(`${retries === 0 ? "开始" : "重新"}播放：${entry.name}`);
        const media = await rewindAndPlay(entry, token);
        const result = await monitorPlayback(entry, media, token);
        if (result.complete) {
          await markVideoCompleted(entry.jobId);
          await addLog(`已完成：${entry.name}`, "success");
          return;
        }
        if (result.paused || token !== runToken || !state.running) {
          return;
        }
        if (await waitForCompletion(entry, token, 5000)) {
          await markVideoCompleted(entry.jobId);
          await addLog(`已完成：${entry.name}`, "success");
          return;
        }
        const snapshot = getCompletionSnapshot(entry);
        await addLog(
          `${entry.name}：${result.reason}；container=${snapshot.containerClasses.join("|") || "无"}，aria=${snapshot.iconLabels.join("|") || "无"}`,
          "warn"
        );
      } catch (error) {
        if (token !== runToken || !state.running) {
          return;
        }
        await addLog(`${entry.name}：${error?.message || "播放异常"}`, "warn");
      }

      if (retries >= CONFIG.maxRetries) {
        const skippedJobIds = [...new Set([...(state.skippedJobIds || []), entry.jobId])];
        const failures = [
          ...(state.failures || []).filter((failure) => failure.jobId !== entry.jobId),
          { jobId: entry.jobId, name: entry.name, lesson: lesson.title, reason: "超过重试上限", retries }
        ];
        await saveState({ skippedJobIds, failures });
        await addLog(`超过${CONFIG.maxRetries}次重试上限，已跳过：${entry.name}`, "error");
        return;
      }
      retries += 1;
      await saveState({
        retries: { ...(state.retries || {}), [entry.jobId]: retries },
        status: `10秒后进行第${retries}/${CONFIG.maxRetries}次重试`
      });
      await sleep(CONFIG.retryDelayMs);
    }
  }

  async function refreshCatalogLesson(lesson, entries) {
    const liveMap = new Map(entries.map((entry) => [entry.jobId, entry]));
    const catalog = (state.catalog || []).map((item) => {
      if (item.lessonId !== lesson.lessonId) {
        return item;
      }
      const existingIds = new Set((item.videos || []).map((video) => video.jobId));
      const videos = (item.videos || []).map((video) => {
        const live = liveMap.get(video.jobId);
        return live
          ? { ...video, name: live.name, completed: isVideoComplete(live), verifiedAt: Date.now() }
          : video;
      });
      entries.forEach((entry) => {
        if (!existingIds.has(entry.jobId)) {
          videos.push({
            jobId: entry.jobId,
            name: entry.name,
            completed: isVideoComplete(entry),
            verifiedAt: Date.now()
          });
        }
      });
      return { ...item, videos };
    });
    const completedIds = new Set(
      catalog.flatMap((item) => item.videos || []).filter((video) => video.completed).map((video) => video.jobId)
    );
    const failures = (state.failures || []).filter(
      (failure) => failure.jobId.startsWith("lesson:") || !completedIds.has(failure.jobId)
    );
    await saveCatalog(catalog, { failures });
  }

  function findNextCatalogTarget() {
    const skipped = new Set(state.skippedJobIds || []);
    for (const lesson of state.catalog || []) {
      const index = (lesson.videos || []).findIndex((video) => !video.completed && !skipped.has(video.jobId));
      if (index >= 0) {
        return { lesson, video: lesson.videos[index], videoIndex: index };
      }
    }
    return null;
  }

  async function processPlayback(token) {
    while (await ensureRunConditions(token)) {
      const target = findNextCatalogTarget();
      if (!target) {
        return true;
      }
      const { lesson, video, videoIndex } = target;
      await saveState({
        currentLessonId: lesson.lessonId,
        currentLessonTitle: `${lesson.section} ${lesson.title}`,
        status: "正在打开待播放视频"
      });
      const opened = getCurrentLessonId() === lesson.lessonId
        ? true
        : await navigateToLesson(lesson, token);
      if (!opened) {
        await handleUnavailableTarget(video, lesson, "章节打开失败");
        continue;
      }

      const entries = await waitForStableVideoEntries(token, false);
      if (!(await ensureRunConditions(token))) {
        return false;
      }
      await refreshCatalogLesson(lesson, entries);
      const liveEntry = entries.find((entry) => entry.jobId === video.jobId);
      if (!liveEntry) {
        await handleUnavailableTarget(video, lesson, "章节中未找到已扫描的视频节点");
        continue;
      }
      await playOneVideo(liveEntry, lesson, videoIndex, token);
    }
    return false;
  }

  async function verifyCatalog(token) {
    const verificationStartedAt = Date.now();
    await saveState({
      phase: "verifying",
      resumePhase: "verifying",
      verificationStartedAt,
      status: "正在最终核验服务器完成状态"
    });
    await addLog("开始最终核验所有已发现的视频。", "success");
    for (let index = 0; index < state.catalog.length; index += 1) {
      if (!(await ensureRunConditions(token))) {
        return false;
      }
      const lesson = state.catalog[index];
      await saveState({ status: `最终核验 ${index + 1}/${state.catalog.length}：${lesson.title}` });
      const opened = getCurrentLessonId() === lesson.lessonId
        ? true
        : await navigateToLesson(lesson, token);
      if (!opened) {
        await addLog(`最终核验时无法打开：${lesson.title}`, "warn");
        const failures = [...(state.failures || [])];
        lesson.videos.forEach((video) => {
          const failure = {
            jobId: video.jobId,
            name: video.name,
            lesson: lesson.title,
            reason: "最终核验时章节无法打开",
            retries: Number(state.retries?.[video.jobId] || 0)
          };
          const existing = failures.findIndex((item) => item.jobId === video.jobId);
          if (existing >= 0) {
            failures[existing] = failure;
          } else {
            failures.push(failure);
          }
        });
        await saveState({ failures });
        continue;
      }
      const entries = await waitForStableVideoEntries(token, false);
      await refreshCatalogLesson(lesson, entries);
    }
    return true;
  }

  async function finishCourse() {
    const videos = (state.catalog || []).flatMap((lesson) => lesson.videos || []);
    const progress = catalogProgress();
    const verifiedCompleted = videos.filter(
      (video) => video.completed && Number(video.verifiedAt || 0) >= Number(state.verificationStartedAt || 0)
    ).length;
    const incomplete = Math.max(0, progress.total - verifiedCompleted);
    const verifiedIds = new Set(
      videos
        .filter((video) => video.completed && Number(video.verifiedAt || 0) >= Number(state.verificationStartedAt || 0))
        .map((video) => video.jobId)
    );
    const unresolvedFailures = (state.failures || []).filter(
      (failure) => failure.jobId.startsWith("lesson:") || !verifiedIds.has(failure.jobId)
    );
    const successful = incomplete === 0 && unresolvedFailures.length === 0;
    await saveState({
      running: false,
      phase: successful ? "complete" : "complete_with_failures",
      status: successful
        ? `${progress.total}个视频已全部核验完成`
        : `本轮结束：${verifiedCompleted}/${progress.total}经最终核验，${incomplete}个未确认，${unresolvedFailures.length}项异常`,
      completed: verifiedCompleted,
      failures: unresolvedFailures,
      currentVideoName: "",
      currentTime: 0,
      duration: 0
    });
    await addLog(successful ? "本课程全部视频已完成。" : "本课程本轮结束，仍有未完成视频。", successful ? "success" : "error");
    await releaseLock();
  }

  async function runLoop(token) {
    if (loopActive) {
      return;
    }
    loopActive = true;
    try {
      if (state.phase === "scanning" || !state.catalogComplete) {
        const scanned = await scanCourse(token);
        if (!scanned) {
          return;
        }
      }
      if (state.phase === "playing") {
        const traversed = await processPlayback(token);
        if (!traversed) {
          return;
        }
      }
      if (state.running && ["playing", "verifying"].includes(state.phase)) {
        const verified = await verifyCatalog(token);
        if (!verified) {
          return;
        }
        await finishCourse();
      }
    } catch (error) {
      if (state.running) {
        await saveState({ running: false, phase: "error", status: `运行异常：${error?.message || "未知错误"}` });
        await addLog(`运行异常：${error?.stack || error?.message || error}`, "error");
        await releaseLock();
      }
    } finally {
      loopActive = false;
    }
  }

  async function launchLoop(token) {
    while (loopActive && token === runToken && state.running) {
      await sleep(200);
    }
    if (token === runToken && state.running) {
      await runLoop(token);
    }
  }

  async function startOrResume() {
    if (hasLegacyExtensionConflict()) {
      state = {
        ...state,
        running: false,
        phase: "paused",
        status: "检测到《创业基础》专用版；请先在扩展管理页禁用其中一个版本"
      };
      renderPanel();
      return;
    }
    const lock = await acquireLock();
    if (!lock?.acquired) {
      state = {
        ...state,
        running: false,
        phase: "observer",
        status: lock?.reason || "同一课程已在其他标签页运行"
      };
      renderPanel();
      return;
    }
    lastLockHeartbeatAt = Date.now();

    const newPass = ["idle", "complete", "complete_with_failures", "error"].includes(state.phase);
    if (newPass) {
      const name = state.name;
      const speedMode = state.speedMode;
      const logs = state.logs || [];
      state = { ...makeFreshState(name), speedMode, logs };
      await saveState({
        running: true,
        phase: "scanning",
        resumePhase: "scanning",
        status: "正在重新扫描课程",
        startedAt: Date.now()
      });
      await addLog("开始新一轮：先扫描全部章节并建立视频清单。", "success");
    } else {
      const nextPhase = state.resumePhase || (state.catalogComplete ? "playing" : "scanning");
      await saveState({ running: true, phase: nextPhase, status: "继续运行" });
      await addLog("继续当前课程。", "success");
    }
    runToken += 1;
    void launchLoop(runToken);
  }

  async function pauseCourse() {
    runToken += 1;
    pauseEveryVideo();
    await saveState({
      running: false,
      resumePhase: state.phase,
      phase: "paused",
      status: "已暂停"
    });
    await addLog("已由用户暂停。", "warn");
    await releaseLock();
  }

  async function changeSpeedMode(value) {
    await saveState({ speedMode: value });
    await addLog(`倍速设置已改为：${value === "auto" ? "自动最高" : `${value}×`}`);
  }

  function exportFailures() {
    const payload = {
      exportedAt: new Date().toISOString(),
      appVersion: CONFIG.appVersion,
      course: metadata(),
      progress: { completed: state.completed, total: state.total },
      failures: state.failures || [],
      logs: state.logs || []
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `学习通失败记录-${state.name.replace(/[\\/:*?\"<>|]/g, "_")}-${Date.now()}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "00:00";
    }
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function ensurePanel() {
    if (panel?.host?.isConnected) {
      return panel;
    }
    const host = document.createElement("div");
    host.id = "cxvu-panel-host";
    host.style.cssText = "position:fixed;top:58px;right:16px;z-index:2147483647;width:440px;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}.panel{font-family:"Microsoft YaHei",system-ui,sans-serif;color:#172033;background:#fff;border:1px solid #cfd6e4;border-radius:12px;box-shadow:0 12px 34px rgba(22,35,55,.24);overflow:hidden}.head{padding:12px 14px;background:#173b68;color:#fff}.title{font-size:16px;font-weight:700}.sub{font-size:11px;opacity:.8;margin-top:3px}.body{padding:13px}.controls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:9px}button,select{min-width:0;padding:8px;border-radius:7px;border:1px solid #d7deea;font-weight:700;background:#f3f6fa;color:#22314b}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}#start{background:#1677ff;color:#fff;border-color:#1677ff}#status{padding:8px 9px;background:#f1f5fa;border-radius:7px;font-size:12px;line-height:1.45;word-break:break-word}.row{display:flex;justify-content:space-between;gap:10px;margin-top:9px;font-size:12px}.bar{height:8px;background:#e7ecf3;border-radius:99px;overflow:hidden;margin-top:5px}.bar>div{height:100%;background:linear-gradient(90deg,#1677ff,#36b36d);width:0;transition:width .2s}.meta{display:grid;gap:4px;margin-top:9px;color:#536078;font-size:11px}.meta b{color:#172033}.section-title{font-size:12px;font-weight:700;margin:11px 0 5px}.courses{max-height:120px;overflow:auto;border:1px solid #e1e6ee;border-radius:7px}.course{display:grid;grid-template-columns:1fr auto;gap:8px;padding:6px 8px;border-bottom:1px solid #edf0f4;font-size:11px}.course:last-child{border-bottom:0}.course.current{background:#eef6ff}.course-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.course-state{color:#66758d}.logs{height:145px;overflow:auto;padding:7px;border-radius:7px;background:#0f1724;color:#d9e2f0;font:10px/1.55 Consolas,monospace;white-space:pre-wrap;word-break:break-word}.log-warn{color:#ffd166}.log-error{color:#ff7b7b}.log-success{color:#62d994}.notice{font-size:10px;color:#7b8799;line-height:1.45;margin-top:7px}
      </style>
      <section class="panel">
        <header class="head"><div class="title">学习通视频播放器 · 通用版</div><div id="course-name" class="sub"></div></header>
        <div class="body">
          <div class="controls"><button id="start">开始 / 继续</button><button id="pause">暂停</button><button id="export">导出失败</button></div>
          <div class="controls"><select id="speed"><option value="auto">自动最高倍速</option><option value="1">最高1×</option><option value="1.25">最高1.25×</option><option value="1.5">最高1.5×</option><option value="2">最高2×</option></select><div></div><div></div></div>
          <div id="status">正在初始化…</div>
          <div class="row"><b>视频进度</b><span id="progress-text">0 / 0</span></div><div class="bar"><div id="progress-bar"></div></div>
          <div class="meta"><div>扫描：<b id="scan">0 / 0</b></div><div>章节：<b id="lesson">—</b></div><div>视频：<b id="video">—</b></div><div>播放：<b id="time">00:00 / 00:00</b>　实际倍速：<b id="rate">1×</b></div><div>本轮失败：<b id="failures">0</b></div></div>
          <div class="section-title">已识别课程</div><div id="courses" class="courses"></div>
          <div class="section-title">当前课程日志</div><div id="logs" class="logs"></div>
          <div class="notice">不同课程标签页可以并行；同一课程只允许一个运行标签页。遇到验证码、人脸或切屏验证时，只停止当前课程。</div>
        </div>
      </section>`;
    document.documentElement.appendChild(host);
    const query = (selector) => shadow.querySelector(selector);
    panel = {
      host,
      courseName: query("#course-name"),
      start: query("#start"),
      pause: query("#pause"),
      export: query("#export"),
      speed: query("#speed"),
      status: query("#status"),
      progressText: query("#progress-text"),
      progressBar: query("#progress-bar"),
      scan: query("#scan"),
      lesson: query("#lesson"),
      video: query("#video"),
      time: query("#time"),
      rate: query("#rate"),
      failures: query("#failures"),
      courses: query("#courses"),
      logs: query("#logs")
    };
    panel.start.addEventListener("click", () => void startOrResume());
    panel.pause.addEventListener("click", () => void pauseCourse());
    panel.export.addEventListener("click", exportFailures);
    panel.speed.addEventListener("change", (event) => void changeSpeedMode(event.target.value));
    return panel;
  }

  function renderPanel() {
    const ui = ensurePanel();
    const percent = state.total > 0 ? Math.min(100, (state.completed / state.total) * 100) : 0;
    ui.courseName.textContent = `${state.name} · v${CONFIG.appVersion}`;
    ui.status.textContent = state.status || "待机";
    ui.progressText.textContent = `${state.completed || 0} / ${state.total || 0}`;
    ui.progressBar.style.width = `${percent}%`;
    ui.scan.textContent = `${state.scanIndex || 0} / ${state.scanTotal || 0}`;
    ui.lesson.textContent = state.currentLessonTitle || "—";
    ui.video.textContent = state.currentVideoName
      ? `${state.currentVideoIndex}/${state.currentVideoCount} ${state.currentVideoName}`
      : "—";
    ui.time.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
    ui.rate.textContent = `${state.selectedRate || 1}×`;
    ui.failures.textContent = String(state.failures?.length || 0);
    ui.speed.value = state.speedMode || "auto";
    ui.start.disabled = state.running;
    ui.pause.disabled = !state.running;
    ui.export.disabled = !(state.failures?.length || state.logs?.length);
    ui.logs.innerHTML = (state.logs || []).map((entry) =>
      `<span class="log-${escapeHtml(entry.level)}">[${escapeHtml(entry.at)}] ${escapeHtml(entry.message)}</span>`
    ).join("\n");
    ui.logs.scrollTop = ui.logs.scrollHeight;
  }

  async function refreshGlobalCourseList() {
    if (!panel?.courses) {
      return;
    }
    const courses = await send({ type: "courses:list" }).catch(() => []);
    const registered = courses.find((course) => course.courseKey === COURSE_KEY);
    if (registered?.name && state.name.startsWith("课程 ")) {
      state.name = registered.name;
    }
    panel.courses.innerHTML = courses.map((course) => {
      const current = course.courseKey === COURSE_KEY ? " current" : "";
      const progress = course.total > 0 ? `${course.completed}/${course.total}` : "未扫描";
      return `<div class="course${current}"><div><div class="course-name" title="${escapeHtml(course.name)}">${escapeHtml(course.name)}</div><div class="course-state">${escapeHtml(course.status)}</div></div><b>${progress}</b></div>`;
    }).join("") || '<div class="course"><span>尚未识别其他课程</span></div>';
    renderPanel();
  }

  async function initialize() {
    ensurePanel();
    const registeredCourses = await send({ type: "courses:list" }).catch(() => []);
    const known = registeredCourses.find((course) => course.courseKey === COURSE_KEY);
    const saved = await send({ type: "state:get", courseKey: COURSE_KEY }).catch(() => null);
    const courseName = known?.name || saved?.name || `课程 ${COURSE_ID}`;

    if (saved?.schema === 1 && saved.appVersion === CONFIG.appVersion) {
      state = { ...makeFreshState(courseName), ...saved, name: courseName };
    } else {
      state = makeFreshState(courseName);
      if (saved) {
        state.logs = [...(saved.logs || []), {
          at: new Date().toLocaleString("zh-CN", { hour12: false }),
          level: "success",
          message: `扩展已升级到 ${CONFIG.appVersion}，运行状态已重置。`
        }].slice(-CONFIG.maxLogs);
      }
    }
    await send({ type: "course:register", metadata: metadata(), state });

    if (state.running && hasLegacyExtensionConflict()) {
      await saveState({
        running: false,
        phase: "paused",
        status: "检测到专用版扩展，通用版未自动恢复；请禁用其中一个版本"
      });
    } else if (state.running) {
      const lock = await acquireLockWithWait();
      if (!lock?.acquired) {
        state = {
          ...state,
          running: false,
          phase: "observer",
          status: lock?.reason || "同一课程已在其他标签页运行"
        };
        renderPanel();
      } else {
        lastLockHeartbeatAt = Date.now();
        await saveState({
          running: true,
          phase: "scanning",
          resumePhase: "scanning",
          status: "页面重新载入，正在重新扫描课程",
          catalog: [],
          catalogComplete: false,
          scanIndex: 0,
          scanTotal: 0,
          completed: 0,
          total: 0,
          retries: {},
          skippedJobIds: [],
          failures: []
        });
        await addLog("页面或Edge已重新载入，按设置重新扫描全部课程章节。", "success");
        runToken += 1;
        void launchLoop(runToken);
      }
    } else {
      await saveState();
    }

    await refreshGlobalCourseList();
    globalListTimer = window.setInterval(() => void refreshGlobalCourseList(), 5000);
  }

  window.addEventListener("beforeunload", () => {
    pauseEveryVideo();
    if (globalListTimer) {
      window.clearInterval(globalListTimer);
    }
  });
  void initialize();
})();
