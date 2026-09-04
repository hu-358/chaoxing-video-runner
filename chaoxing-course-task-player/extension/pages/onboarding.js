"use strict";

const agree = document.querySelector("#agree");
const accept = document.querySelector("#accept");
const status = document.querySelector("#status");

agree.addEventListener("change", () => {
  accept.disabled = !agree.checked;
});

accept.addEventListener("click", () => {
  accept.disabled = true;
  chrome.runtime.sendMessage({ type: "consent:accept" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      status.textContent = response?.error || chrome.runtime.lastError?.message || "保存失败，请重试。";
      accept.disabled = false;
      return;
    }
    status.textContent = "已启用。请返回课程页面，并由你主动点击“开始 / 继续”。";
  });
});

document.querySelector("#demo").addEventListener("click", () => {
  window.open(chrome.runtime.getURL("pages/demo.html"), "_blank", "noopener,noreferrer");
});

chrome.runtime.sendMessage({ type: "consent:get" }, (response) => {
  if (response?.ok && response.result?.accepted) {
    agree.checked = true;
    status.textContent = "你已经完成首次使用确认。";
  }
});
