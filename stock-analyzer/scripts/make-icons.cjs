// Renders public/icons/icon.svg to the PNG sizes iOS / Android / desktop PWAs need.
// Usage: node scripts/make-icons.cjs   (requires Playwright + Chromium, dev-only)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, size, bleed] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['apple-touch-icon.png', 180, true]]) {
    await page.setViewportSize({ width: size, height: size });
    // apple-touch-icon: square full-bleed (iOS applies its own rounded mask)
    const s = bleed ? svg.replace('rx="112"', 'rx="0"') : svg;
    await page.setContent(`<html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, '..', 'public', 'icons', name), omitBackground: !bleed });
  }
  await browser.close();
  console.log('icons written');
})();
