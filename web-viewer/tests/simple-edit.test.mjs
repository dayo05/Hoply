import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { layoutText, validateEdits } from '../src/simple-edit-model.ts';
import * as CFB from 'cfb';
import { normalizeCfbAllocation } from '../src/hwp-record-overlay.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, origin;
before(async () => {
  server = await createServer({ configFile: resolve(root, 'web-viewer/vite.config.ts'), root: resolve(root, 'web-viewer'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); origin = server.resolvedUrls.local[0];
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  browser = await engine.launch({ executablePath: engine === chromium ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined : undefined });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(file = resolve(root, 'docs/review-assets/sample.hwp')) {
  const bytes = await readFile(file);
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await page.route('**/document/current', route => route.fulfill({ body: bytes, headers: { 'X-Document-Name': 'fixture.hwp' } }));
  await page.route('**/rhwp-test.wasm', route => route.fulfill({ path: resolve(root, 'node_modules/@rhwp/core/rhwp_bg.wasm'), contentType: 'application/wasm' }));
  await page.goto(origin);
  await page.waitForSelector('body.is-loaded');
  await page.evaluate(async () => { window.RHWPViewer.renderAllPages(); await document.fonts.ready; });
  return page;
}

test('fixed text regions reject overflow and invalid saved geometry', () => {
  const rect = { x: 0, y: 0, width: 48, height: 36 };
  assert.deepEqual(layoutText('ABCD', rect, 10, s => s.length * 10), ['ABCD']);
  assert.equal(layoutText('ABCDEFGH1234', rect, 10, s => s.length * 10), null);
  assert.throws(() => validateEdits({ schema: 1, items: [{ id: 'x', page: 0, kind: 'text', color: '#000000', rect: { ...rect, width: NaN }, text: 'test', fontSize: 12 }] }, 1));
});

test('CFB allocation padding is valid and normalization preserves stream bytes', () => {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, '/fixture/small', new Uint8Array([1, 2, 3, 4]));
  CFB.utils.cfb_add(container, '/fixture/large', new Uint8Array(7000).fill(37));
  const bytes = new Uint8Array(CFB.write(container, { type: 'array' }));
  normalizeCfbAllocation(bytes);
  const view = new DataView(bytes.buffer);
  const sectorSize = 2 ** view.getUint16(30, true), sectorCount = bytes.length / sectorSize - 1;
  const fat = view.getUint32(76, true);
  for (let index = sectorCount; index < sectorSize / 4; index++) assert.equal(view.getUint32((fat + 1) * sectorSize + 4 * index, true), 0xffffffff);
  const reopened = CFB.read(bytes, { type: 'array' });
  assert.deepEqual([...CFB.find(reopened, '/fixture/small').content], [1, 2, 3, 4]);
  assert.equal(new Uint8Array(CFB.find(reopened, '/fixture/large').content).every(v => v === 37), true);
});

test('read-only default, fixed input, overflow, pen, erase and history leave original SVG untouched', async () => {
  const page = await open();
  try {
    const before = await page.locator('.page > svg:not(.edit-layer)').first().evaluate(e => e.outerHTML);
    assert.equal(await page.locator('.edit-toolbar').isVisible(), false);
    await page.evaluate(() => window.RHWPViewer.setEditing(true));
    await page.getByRole('button', { name: '텍스트', exact: true }).click();
    const layer = page.locator('.edit-layer').first();
    const bounds = await layer.boundingBox();
    await page.mouse.move(bounds.x + 100, bounds.y + 250);
    await page.mouse.down(); await page.mouse.move(bounds.x + 320, bounds.y + 310); await page.mouse.up();
    const input = page.getByRole('textbox', { name: '입력할 내용' });
    await input.fill('가'.repeat(2000));
    assert.equal(await page.getByRole('button', { name: '적용', exact: true }).isDisabled(), true);
    await input.fill('Dayo 서명');
    await page.getByRole('button', { name: '적용', exact: true }).click();
    assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 1);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 0);
    await page.getByRole('button', { name: '다시', exact: true }).click();
    assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 1);
    await page.getByRole('button', { name: '펜', exact: true }).click();
    const draw = async type => page.evaluate(type => {
      const layer = document.querySelector('.edit-layer'); const r = layer.getBoundingClientRect();
      for (const [event, x, y] of [['pointerdown', 350, 330], ['pointermove', 380, 340], ['pointerup', 400, 320]]) layer.dispatchEvent(new PointerEvent(event, { pointerId: 5, pointerType: type, clientX: r.x + x, clientY: r.y + y, pressure: .6, bubbles: true }));
    }, type);
    // Synthetic events cannot acquire capture; suppress only that test platform restriction.
    await page.evaluate(() => { SVGElement.prototype.setPointerCapture = () => {}; });
    await draw('touch'); assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 1);
    await draw('pen'); assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 2);
    await page.getByRole('button', { name: '지우개', exact: true }).click();
    await page.mouse.click(bounds.x + 380, bounds.y + 335);
    assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 1);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await page.evaluate(() => window.RHWPViewer.getEdits().items.length), 2);
    assert.equal(await page.locator('.page > svg:not(.edit-layer)').first().evaluate(e => e.outerHTML), before);
    await page.evaluate(() => window.RHWPViewer.setZoom(1.8));
    const aligned = await page.evaluate(() => { const base = document.querySelector('.page > svg:not(.edit-layer)').getBoundingClientRect(); const layer = document.querySelector('.edit-layer').getBoundingClientRect(); return Math.abs(base.width - layer.width) < .1 && Math.abs(base.height - layer.height) < .1; });
    assert.equal(aligned, true);
    await page.evaluate(() => window.RHWPViewer.setEditing(false));
    assert.equal(await page.locator('.edit-toolbar').isVisible(), false);
    assert.equal(await page.locator('.edit-layer').first().evaluate(e => getComputedStyle(e).pointerEvents), 'none');
  } finally { await page.close(); }
});

test('saved HWP contains editable text and signature, preserves source paint on every page and does not mutate source', async () => {
  const file = process.env.HOPLY_HWP_TEST_FILE || resolve(root, 'docs/review-assets/sample.hwp');
  const page = await open(file);
  try {
    const result = await page.evaluate(async () => {
      const { default: init, HwpDocument } = await import('/node_modules/.vite/deps/@rhwp_core.js');
      await init({ module_or_path: '/rhwp-test.wasm' });
      const { pagePaint, assertOriginalPaint } = await import('/src/hwp-simple-export.ts');
      const bytes = new Uint8Array(await (await fetch('./document/current')).arrayBuffer());
      const original = new HwpDocument(bytes);
      const items = [];
      for (let i = 0; i < original.pageCount(); i++) {
        items.push({ id: 'text-' + i, kind: 'text', page: i, rect: { x: 240, y: 205, width: 160, height: 50 }, color: '#17202a', text: 'Dayo 테스트', fontSize: 13 });
        items.push({ id: 'ink-' + i, kind: 'ink', page: i, rect: { x: 300, y: 800, width: 64, height: 24 }, color: '#17202a', width: 2, points: [{ x: 302, y: 802, pressure: .5 }, { x: 320, y: 820, pressure: .5 }, { x: 350, y: 802, pressure: .5 }] });
      }
      window.RHWPViewer.loadEdits({ schema: 1, items });
      const before = Array.from(document.querySelectorAll('.page > svg:not(.edit-layer)'), e => e.outerHTML);
      const saved = window.RHWPViewer.exportHwp();
      const reloaded = new HwpDocument(Uint8Array.from(atob(saved), s => s.charCodeAt(0)));
      let addedText = 0;
      for (let i = 0; i < original.pageCount(); i++) {
        const svg = reloaded.renderPageSvg(i);
        assertOriginalPaint(pagePaint(original.renderPageSvg(i)), pagePaint(svg));
        const tree = new DOMParser().parseFromString(svg, 'image/svg+xml');
        addedText += [...tree.querySelectorAll('g[clip-path*="textbox-clip-"]')].some(g => g.textContent.replace(/\s/g, '').includes('Dayo테스트')) ? 1 : 0;
      }
      const after = Array.from(document.querySelectorAll('.page > svg:not(.edit-layer)'), e => e.outerHTML);
      const count = original.pageCount(); original.free(); reloaded.free();
      return { count, addedText, unchanged: JSON.stringify(before) === JSON.stringify(after), bytes: atob(saved).length };
    });
    assert.equal(result.unchanged, true);
    assert.equal(result.addedText, result.count);
    assert.ok(result.bytes > 0);
  } finally { await page.close(); }
});

test('render comparison rejects moved original text, border, clip and paint order', async () => {
  const page = await open();
  try {
    const checks = await page.evaluate(async () => {
      const { pagePaint, assertOriginalPaint } = await import('/src/hwp-simple-export.ts');
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="a"><rect width="90" height="90"/></clipPath></defs><g clip-path="url(#a)"><text x="10" y="20">원본</text><line x1="0" y1="30" x2="90" y2="30" stroke="black"/></g></svg>';
      return [source.replace('x="10"', 'x="11"'), source.replace('x2="90"', 'x2="91"'), source.replace('width="90"', 'width="89"')].map(changed => { try { assertOriginalPaint(pagePaint(source), pagePaint(changed)); return false; } catch { return true; } });
    });
    assert.deepEqual(checks, [true, true, true]);
  } finally { await page.close(); }
});
