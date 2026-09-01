(() => {
  "use strict";

  if (window.top !== window.self || window.__CXVR_LOADED__) {
    return;
  }
  window.__CXVR_LOADED__ = true;

  const CONFIG = Object.freeze({
    extensionVersion: chrome.runtime.getManifest().version,
    // Configure these two values locally before loading this archived,
    // course-specific edition. Never commit personal course identifiers.
    courseId: "REPLACE_WITH_COURSE_ID",
    clazzId: "REPLACE_WITH_CLASS_ID",
    totalVideos: 57,
    playbackRate: 2,
    maxRetries: 5,
    retryDelayMs: 10_000,
    completionConfirmWaitMs: 45_000,
    contentWaitMs: 60_000,
    stallTimeoutMs: 30_000,
    expectedVideoLessonCount: 33,
    storageKey: "cxvr_state_v1",
    maxLogs: 220
  });

  const NON_VIDEO_TITLE = /(测试|测验|考试|作业)/;
  let state = makeFreshState();
  let runToken = 0;
  let loopActive = false;
  let panel = null;

  function makeFreshState() {
    return {
      schema: 1,
      appVersion: CONFIG.extensionVersion,
      courseId: CONFIG.courseId,
      clazzId: CONFIG.clazzId,
      running: false,
      phase: "idle",
      status: "待机",
      total: CONFIG.totalVideos,
      completed: 0,
      unfinished: CONFIG.totalVideos,
      currentLessonId: "",
      currentLessonTitle: "",
      currentVideoName: "",
      currentVideoIndex: 0,
      currentVideoCount: 0,
      currentTime: 0,
      duration: 0,
      retries: {},
      skippedJobIds: [],
      processedLessonIds: [],
      failures: [],
      verificationReloaded: false,
      logs: [],
      startedAt: null,
      updatedAt: Date.now()
    };
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result[key]));
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [CONFIG.storageKey]: value }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async function saveState(patch = {}) {
    state = { ...state, ...patch, updatedAt: Date.now() };
    await storageSet(state);
    renderPanel();
  }

  async function addLog(message, level = "info") {
    const entry = {
      at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      level,
      message
    };
    const logs = [...(state.logs || []), entry].slice(-CONFIG.maxLogs);
    await saveState({ logs });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isTargetCourse() {
    const params = new URL(window.location.href).searchParams;
    const courseId = params.get("courseId") || params.get("courseid");
    const clazzId = params.get("clazzid") || params.get("clazzId");
    return courseId === CONFIG.courseId && clazzId === CONFIG.clazzId;
  }

  function getLessonItems() {
    const results = [];
    document.querySelectorAll(".posCatalog_select").forEach((row) => {
      if (row.classList.contains("firstLayer")) {
        return;
      }
      const nameElement = row.querySelector(".posCatalog_name");
      const sectionElement = row.querySelector(".posCatalog_sbar");
      if (!nameElement || !sectionElement) {
        return;
      }

      const section = (sectionElement.textContent || "").trim();
      const topChapter = Number.parseInt(section.split(".")[0], 10);
      if (!Number.isFinite(topChapter) || topChapter < 1 || topChapter > 8) {
        return;
      }

      const title = (nameElement.getAttribute("title") || nameElement.textContent || "").trim();
      const countText = row.querySelector(".catalog_points_yi .orangeNew")?.textContent || "0";
      const unfinished = Number.parseInt(countText.trim(), 10) || 0;
      const lessonId = (row.id || "").replace(/^cur/, "") || extractLessonId(nameElement);

      results.push({
        row,
        nameElement,
        section,
        title,
        lessonId,
        unfinished,
        isVideoLesson: !NON_VIDEO_TITLE.test(title)
      });
    });
    return results;
  }

  function extractLessonId(element) {
    const onclick = element.getAttribute("onclick") || "";
    const match = onclick.match(/getTeacherAjax\([^)]*['\"](\d+)['\"]\s*\)/);
    return match?.[1] || "";
  }

  function scanCourseProgress() {
    const videoLessons = getLessonItems().filter((item) => item.isVideoLesson);
    const unfinished = videoLessons.reduce((sum, item) => sum + item.unfinished, 0);
    return {
      ready: videoLessons.length >= CONFIG.expectedVideoLessonCount,
      videoLessons,
      unfinished,
      completed: Math.max(0, Math.min(CONFIG.totalVideos, CONFIG.totalVideos - unfinished))
    };
  }

  async function waitForCatalog(token) {
    const deadline = Date.now() + CONFIG.contentWaitMs;
    while (Date.now() < deadline && token === runToken && state.running) {
      const progress = scanCourseProgress();
      if (progress.ready) {
        return progress;
      }
      await saveState({ status: "正在等待课程目录加载" });
      await sleep(1000);
    }
    return scanCourseProgress();
  }

  function getCurrentLesson() {
    const active = document.querySelector(".posCatalog_select.posCatalog_active:not(.firstLayer)");
    if (!active) {
      return null;
    }
    return getLessonItems().find((item) => item.row === active) || null;
  }

  function getContentDocument() {
    const frame = document.querySelector("iframe#iframe");
    try {
      return frame?.contentDocument || null;
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

  function getVideoEntries() {
    const contentDocument = getContentDocument();
    if (!contentDocument) {
      return [];
    }
    return [...contentDocument.querySelectorAll("iframe.ans-insertvideo-online")].map((frame, index) => {
      const data = readFrameData(frame);
      const container = frame.closest(".videoContainer") || frame.parentElement;
      const jobId = frame.getAttribute("jobid") || data.jobid || data._jobid || frame.getAttribute("objectid") || `video-${index}`;
      const name = data.name || frame.getAttribute("objectid") || `视频 ${index + 1}`;
      return { frame, container, jobId: String(jobId), name, index };
    });
  }

  function getFreshVideoEntry(entry) {
    return getVideoEntries().find((candidate) => candidate.jobId === entry.jobId) || entry;
  }

  function getCompletionSnapshot(entry) {
    // Chaoxing may replace the complete video container after its final progress
    // report. Always resolve the current node instead of trusting a stale element.
    const freshEntry = getFreshVideoEntry(entry);
    const containers = [...new Set([freshEntry.container, entry.container].filter(Boolean))];
    const icons = containers
      .flatMap((container) => [...container.querySelectorAll(".ans-job-icon")]);

    // On the live page the outer container receives ans-job-finished first. The
    // inner icon's aria-label can remain stale until the chapter is refreshed.
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
      jobId: entry.jobId,
      containerClasses: containers.map((container) => container.className).filter(Boolean),
      iconLabels: icons.map((icon) => icon.getAttribute("aria-label") || "").filter(Boolean)
    };
  }

  function isVideoComplete(entry) {
    return getCompletionSnapshot(entry).complete;
  }

  async function waitForTaskCompletion(entry, token, waitMs, showStatus = true) {
    const deadline = Date.now() + waitMs;
    let lastStatusSecond = -1;
    while (Date.now() < deadline && token === runToken && state.running) {
      if (isVideoComplete(entry)) {
        return true;
      }
      const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (showStatus && secondsLeft !== lastStatusSecond && secondsLeft % 5 === 0) {
        lastStatusSecond = secondsLeft;
        await saveState({ status: `视频已播完，等待平台确认任务点（最多${secondsLeft}秒）` });
      }
      await sleep(1000);
    }
    return isVideoComplete(entry);
  }

  function pauseEveryVideo() {
    getVideoEntries().forEach((entry) => {
      try {
        entry.frame.contentDocument?.querySelector("video")?.pause();
      } catch {
        // The frame may be reloading; it will be paused again on the next page pass.
      }
    });
  }

  async function waitForStableVideos(token) {
    const deadline = Date.now() + CONFIG.contentWaitMs;
    let stableCount = -1;
    let stablePolls = 0;
    while (Date.now() < deadline && token === runToken && state.running) {
      const entries = getVideoEntries();
      if (entries.length > 0 && entries.length === stableCount) {
        stablePolls += 1;
      } else {
        stableCount = entries.length;
        stablePolls = 0;
      }
      if (entries.length > 0 && stablePolls >= 2) {
        return entries;
      }
      await sleep(1000);
    }
    return getVideoEntries();
  }

  async function waitForVideoElement(entry, token) {
    const deadline = Date.now() + CONFIG.contentWaitMs;
    while (Date.now() < deadline && token === runToken && state.running) {
      try {
        const doc = entry.frame.contentDocument;
        const video = doc?.querySelector("video");
        if (doc && video) {
          return { doc, video };
        }
      } catch {
        // The iframe is still loading.
      }
      await sleep(1000);
    }
    return null;
  }

  function findOfficialTwoTimes(doc) {
    const items = [...doc.querySelectorAll(".vjs-playback-rate .vjs-menu-item")];
    return items.find((item) => {
      const text = (item.textContent || "")
        .replace(/\s+/g, "")
        .replace("，", ",")
        .toLowerCase();
      return text === "2x" || text.startsWith("2x,") || text.startsWith("2x选择");
    }) || null;
  }

  async function chooseOfficialTwoTimes(doc, video, token, waitMs = 20_000) {
    const deadline = Date.now() + waitMs;
    let openedMenu = false;

    while (Date.now() < deadline && token === runToken && state.running) {
      const twoTimes = findOfficialTwoTimes(doc);
      if (twoTimes) {
        if (!twoTimes.classList.contains("vjs-selected") || video.playbackRate !== CONFIG.playbackRate) {
          twoTimes.click();
        }
        video.defaultPlaybackRate = CONFIG.playbackRate;
        video.playbackRate = CONFIG.playbackRate;
        return;
      }

      if (!openedMenu) {
        const rateButton = doc.querySelector(
          ".vjs-playback-rate .vjs-menu-button, .vjs-playback-rate button, button.vjs-playback-rate"
        );
        rateButton?.click();
        openedMenu = true;
      }
      await sleep(250);
    }

    throw new Error("等待20秒后仍未加载官方 2× 菜单");
  }

  async function rewindAndPlay(entry, token) {
    const media = await waitForVideoElement(entry, token);
    if (!media) {
      throw new Error("等待播放器加载超时");
    }

    const { doc, video } = media;
    video.muted = true;
    video.volume = 0;

    try {
      await video.play();
    } catch (error) {
      throw new Error(`无法自动播放：${error?.message || "浏览器拒绝播放"}`);
    }

    // The player builds its speed menu lazily after playback starts. Wait for the
    // official 2× entry instead of treating a not-yet-rendered menu as unsupported.
    await chooseOfficialTwoTimes(doc, video, token);

    const metadataDeadline = Date.now() + 20_000;
    while ((!Number.isFinite(video.duration) || video.duration <= 0) && Date.now() < metadataDeadline) {
      if (token !== runToken || !state.running) {
        throw new Error("运行已暂停");
      }
      await sleep(500);
    }

    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = 0;
    }
    video.muted = true;
    video.volume = 0;
    await chooseOfficialTwoTimes(doc, video, token);
    await video.play();
    return video;
  }

  async function monitorPlayback(entry, video, token) {
    let lastTime = -1;
    let lastProgressAt = Date.now();
    let lastSavedAt = 0;

    while (token === runToken && state.running) {
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
      if (video.playbackRate !== CONFIG.playbackRate) {
        try {
          await chooseOfficialTwoTimes(video.ownerDocument, video, token, 5000);
        } catch (error) {
          return { complete: false, reason: error.message };
        }
      }

      if (video.paused && !video.ended) {
        try {
          await video.play();
        } catch {
          // The stall timer below will initiate a retry if playback cannot resume.
        }
      }

      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (currentTime > lastTime + 0.25) {
        lastTime = currentTime;
        lastProgressAt = Date.now();
      }

      if (Date.now() - lastSavedAt >= 5000) {
        lastSavedAt = Date.now();
        await saveState({ currentTime, duration });
      }

      const reachedEnd = video.ended || (duration > 0 && currentTime >= duration - 0.5);
      if (reachedEnd) {
        const confirmed = await waitForTaskCompletion(
          entry,
          token,
          CONFIG.completionConfirmWaitMs,
          true
        );
        if (confirmed) {
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

    try {
      video.pause();
    } catch {
      // Ignore a detached player while pausing.
    }
    return { complete: false, paused: true, reason: "运行已暂停" };
  }

  async function playOneVideo(entry, index, total, token) {
    const skipped = new Set(state.skippedJobIds || []);
    if (skipped.has(entry.jobId) || isVideoComplete(entry)) {
      return;
    }

    await saveState({
      currentVideoName: entry.name,
      currentVideoIndex: index + 1,
      currentVideoCount: total,
      currentTime: 0,
      duration: 0,
      status: `正在播放 ${index + 1}/${total}`
    });

    let retries = Number(state.retries?.[entry.jobId] || 0);
    while (token === runToken && state.running) {
      try {
        await addLog(`${retries === 0 ? "开始" : "重新"}播放：${entry.name}`);
        const video = await rewindAndPlay(entry, token);
        const result = await monitorPlayback(entry, video, token);
        if (result.complete) {
          await addLog(`已完成：${entry.name}`, "success");
          return;
        }
        if (result.paused || token !== runToken || !state.running) {
          return;
        }

        // A detached/reloaded player can report an error just as the parent page
        // replaces its task icon. Give the fresh DOM a short final confirmation.
        if (await waitForTaskCompletion(entry, token, 5000, false)) {
          await addLog(`已完成：${entry.name}`, "success");
          return;
        }
        const snapshot = getCompletionSnapshot(entry);
        await addLog(
          `${entry.name}：${result.reason}；诊断 job=${snapshot.jobId}，container=${snapshot.containerClasses.join("|") || "无"}，aria=${snapshot.iconLabels.join("|") || "无"}`,
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
          ...(state.failures || []).filter((item) => item.jobId !== entry.jobId),
          { jobId: entry.jobId, name: entry.name, lesson: state.currentLessonTitle, retries }
        ];
        await saveState({ skippedJobIds, failures });
        await addLog(`超过${CONFIG.maxRetries}次重试上限，已跳过：${entry.name}`, "error");
        return;
      }

      retries += 1;
      const retryMap = { ...(state.retries || {}), [entry.jobId]: retries };
      await saveState({ retries: retryMap, status: `10秒后进行第 ${retries}/${CONFIG.maxRetries} 次重试` });
      await sleep(CONFIG.retryDelayMs);
    }
  }

  async function processLesson(lesson, token) {
    await saveState({
      currentLessonId: lesson.lessonId,
      currentLessonTitle: `${lesson.section} ${lesson.title}`,
      currentVideoName: "",
      status: "正在读取本节视频"
    });
    await addLog(`进入章节：${lesson.section} ${lesson.title}`);

    const entries = await waitForStableVideos(token);
    if (token !== runToken || !state.running) {
      return { processed: false, paused: true, reason: "运行已暂停" };
    }

    if (entries.length === 0) {
      return { processed: false, reason: "等待60秒后仍未发现视频播放器" };
    }

    for (let index = 0; index < entries.length; index += 1) {
      if (token !== runToken || !state.running) {
        return { processed: false, paused: true, reason: "运行已暂停" };
      }
      await playOneVideo(entries[index], index, entries.length, token);
    }

    const processedLessonIds = [...new Set([...(state.processedLessonIds || []), lesson.lessonId])];
    await saveState({ processedLessonIds, status: "等待平台更新任务点" });
    await sleep(CONFIG.retryDelayMs);
    return { processed: true };
  }

  async function handleLessonFailure(lesson, reason) {
    const retryKey = `lesson:${lesson.lessonId}`;
    let retries = Number(state.retries?.[retryKey] || 0);
    await addLog(`${lesson.section} ${lesson.title}：${reason}`, "warn");

    if (retries >= CONFIG.maxRetries) {
      const processedLessonIds = [...new Set([...(state.processedLessonIds || []), lesson.lessonId])];
      const failures = [
        ...(state.failures || []).filter((item) => item.jobId !== retryKey),
        { jobId: retryKey, name: `${lesson.title}（章节加载失败）`, lesson: lesson.title, retries }
      ];
      await saveState({ processedLessonIds, failures });
      await addLog(`超过${CONFIG.maxRetries}次重试上限，已跳过本节：${lesson.title}`, "error");
      return;
    }

    retries += 1;
    const retryMap = { ...(state.retries || {}), [retryKey]: retries };
    await saveState({ retries: retryMap, status: `10秒后重新加载本节（${retries}/${CONFIG.maxRetries}）` });
    await sleep(CONFIG.retryDelayMs);
  }

  async function navigateToLesson(lesson, token) {
    await saveState({ status: `正在打开 ${lesson.section} ${lesson.title}` });
    lesson.nameElement.click();

    const deadline = Date.now() + CONFIG.contentWaitMs;
    while (Date.now() < deadline && token === runToken && state.running) {
      const current = getCurrentLesson();
      if (current?.lessonId === lesson.lessonId && getContentDocument()) {
        await sleep(1500);
        return true;
      }
      await sleep(500);
    }
    await addLog(`打开章节超时：${lesson.title}`, "warn");
    return false;
  }

  async function finishRun(progress) {
    const failures = state.failures || [];
    const successful = progress.unfinished === 0;
    await saveState({
      running: false,
      phase: successful ? "complete" : "complete_with_failures",
      status: successful
        ? "57个视频任务已全部核验完成"
        : `本轮结束：${failures.length}个视频被跳过，仍有${progress.unfinished}个任务点未完成`,
      completed: progress.completed,
      unfinished: progress.unfinished,
      currentVideoName: "",
      currentTime: 0,
      duration: 0
    });
    await addLog(successful ? "全部视频任务已完成。" : "本轮已结束；点击“开始”可重新尝试仍未完成的视频。", successful ? "success" : "error");
  }

  async function runLoop(token) {
    if (loopActive) {
      return;
    }
    loopActive = true;
    try {
      while (token === runToken && state.running) {
        const progress = await waitForCatalog(token);
        if (token !== runToken || !state.running) {
          return;
        }
        if (!progress.ready) {
          await saveState({ running: false, phase: "error", status: "课程目录加载超时，请刷新页面后继续" });
          await addLog("课程目录加载超时。", "error");
          return;
        }
        await saveState({ completed: progress.completed, unfinished: progress.unfinished });

        const processed = new Set(state.processedLessonIds || []);
        const nextLesson = progress.videoLessons.find(
          (item) => item.unfinished > 0 && !processed.has(item.lessonId)
        );

        if (!nextLesson) {
          if (!state.verificationReloaded) {
            await saveState({ verificationReloaded: true, status: "正在刷新页面并核验服务器进度" });
            await addLog("已完成本轮遍历，刷新页面核验服务器进度。", "success");
            window.location.reload();
            return;
          }
          await finishRun(progress);
          return;
        }

        const current = getCurrentLesson();
        if (current?.lessonId !== nextLesson.lessonId) {
          const opened = await navigateToLesson(nextLesson, token);
          if (!opened) {
            if (token !== runToken || !state.running) {
              return;
            }
            await handleLessonFailure(nextLesson, "打开章节超时");
            continue;
          }
        }

        const refreshedLesson = getCurrentLesson() || nextLesson;
        const result = await processLesson(refreshedLesson, token);
        if (!result.processed && !result.paused && token === runToken && state.running) {
          await handleLessonFailure(refreshedLesson, result.reason);
        }
      }
    } catch (error) {
      await saveState({ running: false, phase: "error", status: `运行异常：${error?.message || "未知错误"}` });
      await addLog(`运行异常：${error?.stack || error?.message || error}`, "error");
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
    if (!isTargetCourse()) {
      await addLog("当前页面不是已配置的目标课程。", "error");
      return;
    }

    const isNewPass = ["idle", "complete", "complete_with_failures", "error"].includes(state.phase);
    if (isNewPass) {
      const retainedLogs = state.logs || [];
      state = { ...makeFreshState(), logs: retainedLogs };
      await saveState({
        running: true,
        phase: "running",
        status: "正在查找第一个未完成视频",
        startedAt: Date.now()
      });
      await addLog("开始新一轮：将只处理服务器仍标记为未完成的视频。", "success");
    } else {
      await saveState({ running: true, phase: "running", status: "继续运行" });
      await addLog("继续运行。", "success");
    }

    runToken += 1;
    void launchLoop(runToken);
  }

  async function pauseRun() {
    runToken += 1;
    pauseEveryVideo();
    await saveState({ running: false, phase: "paused", status: "已暂停" });
    await addLog("已由用户暂停。", "warn");
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "00:00";
    }
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function ensurePanel() {
    if (panel?.host?.isConnected) {
      return panel;
    }

    const host = document.createElement("div");
    host.id = "cxvr-panel-host";
    host.style.cssText = "position:fixed;top:72px;right:18px;z-index:2147483647;width:380px;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel { font-family: "Microsoft YaHei", system-ui, sans-serif; color:#172033; background:#fff; border:1px solid #cfd6e4; border-radius:12px; box-shadow:0 12px 32px rgba(28,39,61,.22); overflow:hidden; }
        .head { padding:13px 15px; background:#173b68; color:#fff; }
        .title { font-size:16px; font-weight:700; }
        .sub { margin-top:4px; font-size:12px; opacity:.8; }
        .body { padding:14px; }
        .buttons { display:flex; gap:8px; margin-bottom:12px; }
        button { flex:1; padding:9px 12px; border:0; border-radius:8px; font-weight:700; cursor:pointer; }
        #start { background:#1677ff; color:#fff; }
        #pause { background:#e8edf5; color:#24324a; }
        button:disabled { opacity:.45; cursor:not-allowed; }
        .status { padding:9px 10px; border-radius:8px; background:#f2f6fb; font-size:13px; line-height:1.5; word-break:break-word; }
        .progress-row { display:flex; justify-content:space-between; margin:12px 0 6px; font-size:13px; font-weight:700; }
        .bar { height:8px; background:#e8edf5; border-radius:99px; overflow:hidden; }
        .bar > div { height:100%; width:0; background:linear-gradient(90deg,#1677ff,#35b46f); transition:width .25s; }
        .meta { margin-top:10px; display:grid; gap:5px; font-size:12px; color:#536078; }
        .meta b { color:#172033; }
        .logs-title { margin:13px 0 6px; display:flex; justify-content:space-between; font-size:12px; font-weight:700; }
        .logs { height:170px; overflow:auto; padding:8px; border:1px solid #e0e5ee; border-radius:8px; background:#0f1724; color:#d9e2f0; font:11px/1.55 Consolas, monospace; white-space:pre-wrap; word-break:break-word; }
        .log-warn { color:#ffd166; }
        .log-error { color:#ff7b7b; }
        .log-success { color:#62d994; }
        .notice { margin-top:9px; font-size:11px; color:#758198; line-height:1.45; }
      </style>
      <section class="panel">
        <header class="head">
          <div class="title">指定课程 · 视频播放器</div>
          <div class="sub">官方2× · 静音 · 真实完成信号</div>
        </header>
        <div class="body">
          <div class="buttons">
            <button id="start">开始 / 继续</button>
            <button id="pause">暂停</button>
          </div>
          <div id="status" class="status">正在初始化…</div>
          <div class="progress-row"><span>视频任务进度</span><span id="progress-text">0 / 57</span></div>
          <div class="bar"><div id="progress-bar"></div></div>
          <div class="meta">
            <div>章节：<b id="lesson">—</b></div>
            <div>视频：<b id="video">—</b></div>
            <div>播放：<b id="time">00:00 / 00:00</b></div>
            <div>跳过：<b id="failures">0</b></div>
          </div>
          <div class="logs-title"><span>运行日志</span><span>单视频最多重试5次</span></div>
          <div id="logs" class="logs"></div>
          <div class="notice">跳过的视频不会被计为完成；本轮结束后再次点击“开始”可重新尝试仍未完成的视频。</div>
        </div>
      </section>`;
    document.documentElement.appendChild(host);

    const query = (selector) => shadow.querySelector(selector);
    panel = {
      host,
      start: query("#start"),
      pause: query("#pause"),
      status: query("#status"),
      progressText: query("#progress-text"),
      progressBar: query("#progress-bar"),
      lesson: query("#lesson"),
      video: query("#video"),
      time: query("#time"),
      failures: query("#failures"),
      logs: query("#logs")
    };
    panel.start.addEventListener("click", () => void startOrResume());
    panel.pause.addEventListener("click", () => void pauseRun());
    return panel;
  }

  function renderPanel() {
    const ui = ensurePanel();
    const percent = Math.max(0, Math.min(100, (state.completed / CONFIG.totalVideos) * 100));
    ui.status.textContent = state.status || "待机";
    ui.progressText.textContent = `${state.completed || 0} / ${CONFIG.totalVideos}`;
    ui.progressBar.style.width = `${percent}%`;
    ui.lesson.textContent = state.currentLessonTitle || "—";
    ui.video.textContent = state.currentVideoName
      ? `${state.currentVideoIndex}/${state.currentVideoCount} ${state.currentVideoName}`
      : "—";
    ui.time.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
    ui.failures.textContent = String(state.failures?.length || 0);
    ui.start.disabled = state.running || !isTargetCourse();
    ui.pause.disabled = !state.running;
    ui.logs.innerHTML = (state.logs || []).map((entry) => {
      const safeMessage = String(entry.message)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `<span class="log-${entry.level}">[${entry.at}] ${safeMessage}</span>`;
    }).join("\n");
    ui.logs.scrollTop = ui.logs.scrollHeight;
  }

  async function initialize() {
    ensurePanel();
    const saved = await storageGet(CONFIG.storageKey);
    if (saved?.schema === 1 && saved.courseId === CONFIG.courseId && saved.clazzId === CONFIG.clazzId) {
      if (saved.appVersion === CONFIG.extensionVersion) {
        state = { ...makeFreshState(), ...saved };
      } else {
        const upgradeLog = {
          at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level: "success",
          message: `扩展已升级到 ${CONFIG.extensionVersion}，旧版的重试和跳过状态已清除。`
        };
        state = {
          ...makeFreshState(),
          logs: [...(saved.logs || []), upgradeLog].slice(-CONFIG.maxLogs),
          status: `已升级到 ${CONFIG.extensionVersion}，请点击“开始 / 继续”开始新一轮`
        };
      }
    }

    if (!isTargetCourse()) {
      await saveState({ running: false, phase: "idle", status: "此扩展只适用于本地配置的目标课程" });
      return;
    }

    const progress = scanCourseProgress();
    if (progress.ready) {
      await saveState({ completed: progress.completed, unfinished: progress.unfinished });
    } else {
      await saveState({ status: state.running ? "正在等待课程目录加载并恢复运行" : "正在等待课程目录加载" });
    }
    if (state.running) {
      await addLog("页面已重新载入，自动恢复运行。", "success");
      runToken += 1;
      void launchLoop(runToken);
    } else {
      renderPanel();
    }
  }

  window.addEventListener("beforeunload", pauseEveryVideo);
  void initialize();
})();
