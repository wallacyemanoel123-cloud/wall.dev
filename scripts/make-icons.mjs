// Gera os ícones PNG do PWA a partir dos SVGs usando o Chromium do Playwright.
// Uso: npm run icons   (requer Chromium; defina CHROMIUM_PATH se necessário)
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const jobs = [['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['maskable.svg', 'maskable-512.png', 512], ['maskable.svg', 'apple-touch-icon.png', 180]];
for (const [src, out, size] of jobs) {
  const svg = await readFile(new URL(`../public/icons/${src}`, import.meta.url), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/${out}`, import.meta.url).pathname, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('Ícones gerados em public/icons/.');
