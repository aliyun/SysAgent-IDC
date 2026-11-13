const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const path = require('node:path');
const { acceptance, noGpuAcceptance } = require('./acceptance.cjs');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    const httpRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { if (/^https?:/.test(request.url())) httpRequests.push(request.url()); });
    const outputDir = path.join(__dirname, 'output');
    const name = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'new';
    const withGpu = (flag) => {
      const url = new URL(process.argv[2]);
      url.searchParams.set('gpu', flag);
      return url.href;
    };
    await page.goto(withGpu('1'), { waitUntil: 'load' });
    const result = await acceptance(page, outputDir, name);
    if (!process.argv.includes('--gpu-only')) {
      await page.goto(withGpu('0'), { waitUntil: 'load' });
      result.noGpu = await noGpuAcceptance(page, outputDir, `${name}-no-gpu`);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    if (process.argv[2].startsWith('file:')) assert.equal(httpRequests.length, 0, httpRequests.join('\n'));
    console.log(JSON.stringify({ ...result, errors, httpRequests: httpRequests.length }));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
