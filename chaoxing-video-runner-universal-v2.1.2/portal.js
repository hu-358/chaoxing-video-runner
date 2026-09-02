(() => {
  "use strict";

  if (window.top !== window.self || window.__CXVU_PORTAL_LOADED__) {
    return;
  }
  window.__CXVU_PORTAL_LOADED__ = true;

  const params = new URL(window.location.href).searchParams;
  const courseId = params.get("courseid") || params.get("courseId");
  const clazzId = params.get("clazzid") || params.get("clazzId");
  if (!courseId || !clazzId || window.location.pathname.includes("/mycourse/studentstudy")) {
    return;
  }

  function findCourseName() {
    const title = document.title.trim();
    if (title && title.length <= 100 && !/学生学习页面|超星|学习通|在线学习诚信承诺书/.test(title)) {
      return title;
    }
    const selectors = [
      "dl dd",
      ".course-name",
      ".courseName",
      ".course_name",
      "[class*='course'] h1",
      "[class*='course'] h2"
    ];
    for (const selector of selectors) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text && text.length <= 100 && !/课程门户|章节详情|学生学习页面|在线学习诚信承诺书/.test(text)) {
        return text;
      }
    }
    return `课程 ${courseId}`;
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // The extension may be reloading; the next portal visit will register again.
    }
  }

  function register() {
    const courseKey = `${courseId}:${clazzId}`;
    send({
      type: "course:register",
      metadata: { courseKey, courseId, clazzId, name: findCourseName() }
    });
  }

  register();
  window.setTimeout(register, 2500);
})();
