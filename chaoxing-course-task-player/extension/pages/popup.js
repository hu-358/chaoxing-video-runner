"use strict";

function openPage(name) {
  window.open(chrome.runtime.getURL(`pages/${name}`), "_blank", "noopener,noreferrer");
}

const state = document.querySelector("#consent-state");
const status = document.querySelector("#status");

chrome.runtime.sendMessage({ type: "consent:get" }, (response) => {
  const accepted = Boolean(response?.ok && response.result?.accepted);
  state.textContent = accepted ? "首次使用说明：已确认" : "首次使用说明：尚未确认";
  state.classList.toggle("pending", !accepted);
});

document.querySelector("#onboarding").addEventListener("click", () => openPage("onboarding.html"));
document.querySelector("#demo").addEventListener("click", () => openPage("demo.html"));
document.querySelector("#privacy").addEventListener("click", () => openPage("privacy.html"));
document.querySelector("#clear").addEventListener("click", () => {
  if (!window.confirm("确定清除全部课程数据、设置和首次使用确认吗？")) return;
  chrome.runtime.sendMessage({ type: "data:clear-all" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      status.textContent = response?.error || chrome.runtime.lastError?.message || "清除失败。";
      return;
    }
    state.textContent = "首次使用说明：尚未确认";
    state.classList.add("pending");
    status.textContent = "全部本地数据已清除。";
  });
});
