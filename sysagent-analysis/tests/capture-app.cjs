const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(outputDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickText(page, text) {
  const ok = await page.evaluate((text) => {
    const all = [...document.querySelectorAll('button, a')];
    const el = all.find((b) => (b.getAttribute('aria-label') || '').includes(text) || (b.textContent || '').trim().includes(text));
    if (!el) return false;
    el.click();
    return true;
  }, text);
  if (!ok) console.log('MISS CLICK:', text);
  await sleep(600);
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setViewport({ width: 1440, height: 960 });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' });
  await sleep(900);
  await page.evaluate(() => document.querySelector('button[aria-label="打开SysAgent管家"]')?.click());
  await sleep(900);
  await page.screenshot({ path: path.join(outputDir, 'app-overview.png') });
  for (const [label, file] of [['设备管理','devices'],['GPU 诊断','gpu'],['Agent 管家','agents'],['研发运维','ops'],['日志分析','logs']]) {
    await clickText(page, label);
    await page.screenshot({ path: path.join(outputDir, `app-${file}.png`) });
  }
  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
