import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { layoutText, validateEdits } from '../src/simple-edit-model.ts';
import * as CFB from 'cfb';
import { normalizeCfbAllocation } from '../src/hwp-fixed-container.ts';

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

test('saved HWP freezes each form page, preserves paper sizes and retains editable input', async () => {
  const file = process.env.HOPLY_HWP_TEST_FILE || resolve(root, 'docs/review-assets/sample.hwp');
  const page = await open(file);
  try {
    const result = await page.evaluate(async () => {
      const { default: init, HwpDocument } = await import('/node_modules/.vite/deps/@rhwp_core.js');
      await init({ module_or_path: '/rhwp-test.wasm' });
      const bytes = new Uint8Array(await (await fetch('./document/current')).arrayBuffer());
      const original = new HwpDocument(bytes);
      const items = [];
      for (let i = 0; i < original.pageCount(); i++) {
        items.push({ id: 'text-' + i, kind: 'text', page: i, rect: { x: 240, y: 205, width: 160, height: 50 }, color: '#17202a', text: 'Dayo 테스트', fontSize: 13 });
        items.push({ id: 'ink-' + i, kind: 'ink', page: i, rect: { x: 300, y: 800, width: 64, height: 24 }, color: '#17202a', width: 2, points: [{ x: 302, y: 802, pressure: .5 }, { x: 320, y: 820, pressure: .5 }, { x: 350, y: 802, pressure: .5 }] });
      }
      window.RHWPViewer.loadEdits({ schema: 1, items });
      const before = Array.from(document.querySelectorAll('.page > svg:not(.edit-layer)'), e => e.outerHTML);
      const saved = await window.RHWPViewer.exportHwp();
      const reloaded = new HwpDocument(Uint8Array.from(atob(saved), s => s.charCodeAt(0)));
      let addedText = 0;
      for (let i = 0; i < original.pageCount(); i++) {
        const svg = reloaded.renderPageSvg(i);
        const info = JSON.parse(reloaded.getPageInfo(i)), sourceInfo = JSON.parse(original.getPageInfo(i));
        if (info.width !== sourceInfo.width || info.height !== sourceInfo.height) throw new Error('paper changed');
        const controls = JSON.parse(reloaded.getPageControlLayout(i)).controls;
        const background = controls.find(c => c.type === 'image' && JSON.parse(reloaded.getPictureProperties(c.secIdx, c.paraIdx, c.controlIdx)).description === `HoplyBackground:${i}:page`);
        if (!background || background.x !== 0 || background.y !== 0) throw new Error('background moved');
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

test('page freezing preserves colored marks and white paper pixels', async () => {
  const page = await open();
  try {
    const checks = await page.evaluate(async () => {
      const { freezePage } = await import('/src/hwp-simple-export.ts');
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" fill="white"/><rect x="10" y="20" width="40" height="20" fill="red"/><path d="M10 50H90" stroke="black"/></svg>';
      const result = await freezePage(source);
      const image = new Image(); image.src = URL.createObjectURL(new Blob([result.png], { type: 'image/png' })); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = result.pixelsWide; canvas.height = result.pixelsHigh;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const red = context.getImageData(60, 90, 1, 1).data, white = context.getImageData(6, 6, 1, 1).data;
      URL.revokeObjectURL(image.src);
      return [result.width === 120 && result.height === 80, red[0] === 255 && red[1] === 0 && red[2] === 0, white[0] === 255 && white[1] === 255];
    });
    assert.deepEqual(checks, [true, true, true]);
  } finally { await page.close(); }
});

test('mixed paper sizes keep separate backgrounds and native input on its own page', async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const { exportSimpleHwp } = await import('/src/hwp-simple-export.ts');
      const { default: init, HwpDocument } = await import('/node_modules/.vite/deps/@rhwp_core.js');
      await init({ module_or_path: '/rhwp-test.wasm' });
      const sizes = [[400, 600], [600, 400], [500, 700]];
      const sources = sizes.map(([w, h], i) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="white"/><rect x="10" y="20" width="40" height="20" fill="${['red', 'green', 'blue'][i]}"/></svg>`);
      const items = [{ id: 'middle', kind: 'text', page: 1, rect: { x: 100, y: 100, width: 160, height: 50 }, text: 'Editable', fontSize: 13, color: '#17202a' },
        { id: 'signature', kind: 'ink', page: 2, rect: { x: 100, y: 100, width: 64, height: 24 }, width: 2, color: '#17202a', points: [{ x: 102, y: 102, pressure: .5 }, { x: 140, y: 120, pressure: .5 }] }];
      // This export path only consumes the immutable source's page count.
      const bytes = await exportSimpleHwp({ pageCount: () => 3 }, items, sources);
      const doc = new HwpDocument(bytes);
      try {
        const pages = sizes.map((size, i) => {
          const info = JSON.parse(doc.getPageInfo(i));
          const controls = JSON.parse(doc.getPageControlLayout(i)).controls;
          const descriptions = controls.map(c => JSON.parse(c.type === 'image' ? doc.getPictureProperties(c.secIdx, c.paraIdx, c.controlIdx) : doc.getShapeProperties(c.secIdx, c.paraIdx, c.controlIdx)).description);
          const svg = new DOMParser().parseFromString(doc.renderPageSvg(i), 'image/svg+xml');
          const image = svg.querySelector('image');
          const text = svg.querySelector('g[clip-path*="textbox-clip-"] text');
          const textAboveBackground = !text || Boolean(image.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING);
          return { size: [info.width, info.height], descriptions: descriptions.sort(), text: [...svg.querySelectorAll('text')].map(t => t.textContent).join(''), textAboveBackground };
        });
        const field = JSON.parse(doc.getPageControlLayout(1)).controls.find(c => c.type === 'shape');
        const mutation = JSON.parse(doc.insertTextInCell(field.secIdx, field.paraIdx, field.controlIdx, 0, 0, 0, 'Changed '));
        if (mutation.error || mutation.ok === false) throw new Error(JSON.stringify(mutation));
        const edited = new HwpDocument(doc.exportHwp());
        let editable;
        try {
          const tree = new DOMParser().parseFromString(edited.renderPageSvg(1), 'image/svg+xml');
          editable = [...tree.querySelectorAll('text')].map(t => t.textContent).join('');
        } finally { edited.free(); }
        return { pages, count: doc.pageCount(), editable };
      } finally { doc.free(); }
    });
    assert.equal(result.count, 3);
    assert.deepEqual(result.pages.map(p => p.size), [[400, 600], [600, 400], [500, 700]]);
    assert.deepEqual(result.pages.map(p => p.descriptions), [
      ['HoplyBackground:0:page'], ['HoplyBackground:1:page', 'HoplyInput:middle:0:text'], ['HoplyBackground:2:page', 'HoplyInput:signature:ink']
    ]);
    assert.equal(result.pages[0].text.includes('Editable'), false);
    assert.equal(result.pages[1].text.includes('Editable'), true);
    assert.equal(result.pages[2].text.includes('Editable'), false);
    assert.equal(result.pages.every(p => p.textAboveBackground), true);
    assert.match(result.editable.replace(/\s/g, ''), /ChangedEditable/);
  } finally { await page.close(); }
});
