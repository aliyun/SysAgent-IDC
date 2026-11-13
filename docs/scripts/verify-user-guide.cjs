const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const puppeteer = require(require.resolve('puppeteer-core', { paths: [path.join(root, 'sysagent-analysis/tests')] }));
const guide = path.join(root, 'docs/FUNCTION-USER-GUIDE.html');
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--disable-dev-shm-usage'] });
  const errors = [], foreign = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith('file:') || request.url().startsWith('data:')) request.continue();
      else { foreign.push(request.url()); request.abort(); }
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(pathToFileURL(guide).href, { waitUntil: 'load' });
    const inspect = () => page.evaluate(async () => {
      await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = image.onerror = resolve; })));
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      return { images: document.images.length,
        missing: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute('src')),
        duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        toc: document.querySelectorAll('nav a[href^="#"]').length,
        headings: [...document.querySelectorAll('h2')].map(node => node.textContent),
      };
    });
    const desktop = await inspect();
    assert.equal(desktop.images, 26);
    assert.deepEqual(desktop.missing, []);
    assert.deepEqual(desktop.duplicateIds, []);
    assert.equal(desktop.overflow, false);
    assert(desktop.headings.some(text => text.includes('第三方程序怎样对接')));
    await page.screenshot({ path: path.join(root, 'docs/assets/user-guide/guide-preview.png') });
    await page.evaluate(() => [...document.querySelectorAll('nav a')].find(node => node.textContent.includes('第三方程序')).click());
    assert(await page.evaluate(() => location.hash && document.querySelector(location.hash)?.textContent.includes('第三方程序')));
    await page.setViewport({ width: 390, height: 844 });
    const mobile = await inspect();
    assert.equal(mobile.overflow, false);
    assert.deepEqual(mobile.missing, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, []);
    const result = { desktop, mobile, errors, foreign_requests: foreign, verified_at: new Date().toISOString() };
    fs.writeFileSync(path.join(root, 'docs/assets/user-guide/document-validation.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ images: desktop.images, navigation: 'ok', desktop: 'ok', mobile: 'ok', errors, foreignRequests: foreign }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
