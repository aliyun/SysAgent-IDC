const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('../../sysagent-analysis/node_modules/puppeteer-core');

(async () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(publicDir, 'icon.svg')).href);
    const icon = path.join(__dirname, 'icon.png');
    await page.screenshot({ path: icon, omitBackground: true });
    fs.copyFileSync(icon, path.join(publicDir, 'icon.png'));

    const iconsDir = path.join(__dirname, 'icons');
    fs.mkdirSync(iconsDir, { recursive: true });
    const svg = fs.readFileSync(path.join(publicDir, 'icon.svg'), 'utf8');
    await page.goto('about:blank');
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
      await page.screenshot({ path: path.join(iconsDir, `${size}x${size}.png`), omitBackground: true });
    }
    console.log('Generated mascot icons: 1024 window icon plus hicolor sizes 16–1024 in build/icons.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
