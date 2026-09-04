"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const background = path.join(root, "design", "generated-promotional-background.png");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function iconSvg(size) {
  const scale = size / 300;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 300 300">
    <rect width="300" height="300" rx="62" fill="#173B68"/>
    <path d="M77 52h125l38 38v137H77z" fill="#fff"/>
    <path d="M202 52v40h38" fill="#d9e9ff"/>
    <rect x="103" y="118" width="75" height="13" rx="6.5" fill="#1677FF"/>
    <rect x="103" y="148" width="91" height="13" rx="6.5" fill="#1677FF"/>
    <rect x="103" y="178" width="63" height="13" rx="6.5" fill="#1677FF"/>
    <circle cx="211" cy="211" r="58" fill="#36B36D"/>
    <path d="M181 211l20 20 40-46" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`);
}

function promoOverlay(width, height, compact = false) {
  const titleSize = compact ? 31 : 58;
  const subSize = compact ? 15 : 25;
  const x = compact ? 28 : 80;
  const y = compact ? 74 : 190;
  const subtitle = compact ? "本地运行 · 免费无广告" : "用户主动启动 · 仅本地保存 · 免费无广告";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#071c38" stop-opacity=".94"/><stop offset=".58" stop-color="#071c38" stop-opacity=".58"/><stop offset="1" stop-color="#071c38" stop-opacity="0"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    <text x="${x}" y="${y}" fill="#fff" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="${titleSize}" font-weight="700">${compact ? "课程任务播放器" : "学习通课程任务播放器"}</text>
    <text x="${x}" y="${y + titleSize + 22}" fill="#cfe2ff" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="${subSize}">${subtitle}</text>
    <rect x="${x}" y="${y + titleSize + 52}" width="${compact ? 112 : 170}" height="${compact ? 30 : 42}" rx="${compact ? 15 : 21}" fill="#36B36D"/>
    <text x="${x + (compact ? 56 : 85)}" y="${y + titleSize + (compact ? 73 : 82)}" text-anchor="middle" fill="#fff" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="${compact ? 13 : 19}" font-weight="700">通用版 2.2.0</text>
  </svg>`);
}

async function main() {
  const extensionIcons = path.join(root, "extension", "icons");
  const storeLogo = path.join(root, "store-assets", "logo");
  const promotional = path.join(root, "store-assets", "promotional");
  const docsAssets = path.join(root, "docs", "assets");
  [extensionIcons, storeLogo, promotional, docsAssets].forEach(ensureDir);

  for (const size of [16, 32, 48, 128]) {
    const output = size === 128
      ? path.join(root, "extension", "icon-128.png")
      : path.join(extensionIcons, `icon-${size}.png`);
    await sharp(iconSvg(size)).png().toFile(output);
  }
  await sharp(iconSvg(300)).png().toFile(path.join(storeLogo, "store-logo-300.png"));
  await sharp(iconSvg(128)).png().toFile(path.join(docsAssets, "logo-128.png"));

  await sharp(background)
    .resize(1400, 560, { fit: "cover", position: "centre" })
    .composite([{ input: promoOverlay(1400, 560) }])
    .png()
    .toFile(path.join(promotional, "large-promo-1400x560.png"));

  await sharp(background)
    .resize(440, 280, { fit: "cover", position: "centre" })
    .composite([{ input: promoOverlay(440, 280, true) }])
    .png()
    .toFile(path.join(promotional, "small-promo-440x280.png"));

  console.log("Store logos and promotional assets generated.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
