import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { scopeSvgIds } from '../src/svg-ids.ts';

let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
});
after(async () => { await browser?.close(); });

async function newPage() {
  const page = await browser.newPage();
  await page.addScriptTag({ content: `window.scopeSvgIds = ${scopeSvgIds.toString()};` });
  return page;
}

test('a second inline page matches its standalone rendering after ID scoping', async () => {
  const page = await newPage();
  try {
    const svg = (width, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100" style="display:block"><defs><clipPath id="cell-clip-8"><rect width="${width}" height="100"/></clipPath></defs><rect width="120" height="100" fill="${color}" clip-path="url(#cell-clip-8)"/></svg>`;
    const first = svg(20, 'red');
    const second = svg(120, 'blue');
    await page.setContent(second);
    const standalone = await page.locator('svg').screenshot();
    await page.setContent(first + second);
    const colliding = await page.locator('svg').nth(1).screenshot();
    assert.notDeepEqual(colliding, standalone, 'the fixture must reproduce cross-page clipping');
    await page.evaluate(() => {
      document.querySelectorAll('svg').forEach((svg, index) => window.scopeSvgIds(svg, `page-${index}-`));
    });
    assert.deepEqual(await page.locator('svg').nth(1).screenshot(), standalone);
  } finally { await page.close(); }
});

test('local paint and href references follow their renamed definitions', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="root"><defs><linearGradient id="paint"/><path id="shape"/></defs><use href="#shape" xlink:href="#shape" fill="url('#paint')" style="filter: url( &quot;#paint&quot; )"/></svg>`);
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      window.scopeSvgIds(svg, 'page-7-');
      const use = svg.querySelector('use');
      return {
        ids: [svg, ...svg.querySelectorAll('[id]')].map(element => element.id),
        href: use.getAttribute('href'),
        xlink: use.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
        fill: use.getAttribute('fill'),
        style: use.getAttribute('style'),
      };
    });
    assert.deepEqual(result, {
      ids: ['page-7-root', 'page-7-paint', 'page-7-shape'],
      href: '#page-7-shape', xlink: '#page-7-shape',
      fill: 'url(#page-7-paint)', style: 'filter: url(#page-7-paint)',
    });
  } finally { await page.close(); }
});

test('external URLs and unresolved fragment references remain intact', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape"/></defs><image href="data:image/png;base64,AA=="/><use href="other.svg#shape" fill="url(other.svg#shape)"/><rect clip-path="url(#unknown)"/></svg>`);
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      window.scopeSvgIds(svg, 'page-0-');
      return [svg.querySelector('image').getAttribute('href'), svg.querySelector('use').getAttribute('href'), svg.querySelector('use').getAttribute('fill'), svg.querySelector('rect').getAttribute('clip-path')];
    });
    assert.deepEqual(result, ['data:image/png;base64,AA==', 'other.svg#shape', 'url(other.svg#shape)', 'url(#unknown)']);
  } finally { await page.close(); }
});
