"use strict";

const scenes = {
  overview: { status: "已扫描 3 个章节、8 个视频与文档任务", task: "等待处理后续任务", progress: "5 / 8", width: "62.5%", failure: "0" },
  video: { status: "正在真实播放示例视频", task: "示例视频：认识数字信息", progress: "5 / 8", width: "62.5%", failure: "0" },
  document: { status: "正在浏览文档第 8 / 12 页", task: "示例文档：网络安全阅读材料", progress: "6 / 8", width: "75%", failure: "0" },
  blocked: { status: "检测到身份验证提示，当前课程已暂停", task: "需要用户处理页面验证", progress: "6 / 8", width: "75%", failure: "1" }
};

function applyScene(name) {
  const scene = scenes[name] || scenes.overview;
  document.querySelector("#status").textContent = scene.status;
  document.querySelector("#task").textContent = scene.task;
  document.querySelector("#progress-text").textContent = scene.progress;
  document.querySelector("#progress-bar").style.width = scene.width;
  document.querySelector("#failure-count").textContent = scene.failure;
  document.querySelector("#video-scene").classList.toggle("hidden", name === "document" || name === "blocked");
  document.querySelector("#document-scene").classList.toggle("hidden", name !== "document");
  document.querySelector("#blocked-scene").classList.toggle("hidden", name !== "blocked");
  if (name === "blocked") {
    document.querySelector("#logs").textContent = "[14:22:10] 检测到身份验证提示\n[14:22:10] 已暂停；未尝试绕过验证\n[14:22:11] 等待用户返回页面处理";
  }
}

document.querySelector("#start").addEventListener("click", () => applyScene("video"));
document.querySelector("#pause").addEventListener("click", () => {
  document.querySelector("#status").textContent = "已由用户暂停";
});
document.querySelector("#privacy").addEventListener("click", () => {
  window.open("privacy.html", "_blank", "noopener,noreferrer");
});

applyScene(new URL(window.location.href).searchParams.get("scene") || "overview");
