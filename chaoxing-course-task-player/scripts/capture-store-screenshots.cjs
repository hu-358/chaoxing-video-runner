"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const pages = path.join(root, "extension", "pages");
const output = path.join(root, "store-assets", "screenshots");

async function capture(page, file, url) {
  await page.goto(url, { waitUntil: "load" });
  await page.screenshot({ path: path.join(output, file), type: "png" });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  await capture(page, "01-first-use-1280x800.png", pathToFileURL(path.join(pages, "onboarding.html")).href);
  const demo = pathToFileURL(path.join(pages, "demo.html")).href;
  await capture(page, "02-overview-1280x800.png", `${demo}?scene=overview`);
  await capture(page, "03-video-1280x800.png", `${demo}?scene=video`);
  await capture(page, "04-document-1280x800.png", `${demo}?scene=document`);
  await capture(page, "05-verification-pause-1280x800.png", `${demo}?scene=blocked`);
  await capture(page, "06-privacy-1280x800.png", pathToFileURL(path.join(pages, "privacy.html")).href);

  await browser.close();
  console.log("Six 1280x800 store screenshots captured.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
