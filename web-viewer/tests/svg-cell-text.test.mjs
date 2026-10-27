import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { fitSvgCellText } from '../src/svg-cell-text.ts';

const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
let browser;
before(async () => {
  browser = await engine.launch({
    executablePath: engine === chromium ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined : undefined,
  });
});
after(async () => { await browser?.close(); });

const glyphs = (lastX = 20) => [0, 10, lastX].map((x, i) =>
  `<text x="${x}" y="25" font-family="monospace" font-size="16" textLength="10" lengthAdjust="spacingAndGlyphs">${'ABC'[i]}</text>`
).join('');
const fixture = (text = glyphs(), clip = '<rect width="29.5" height="50"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><clipPath id="cell-clip-8">${clip}</clipPath></defs><g clip-path="url(#cell-clip-8)">${text}</g></svg>`;

async function withPage(markup, check) {
  const page = await browser.newPage();
  try {
    await page.setContent(markup);
    await page.addScriptTag({ content: `window.fitSvgCellText = ${fitSvgCellText.toString()}` });
    await check(page);
  } finally { await page.close(); }
}

test('a clipped final glyph fits without changing content, baseline or clip geometry', async () => {
  await withPage(fixture(), async page => {
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      const rect = svg.querySelector('clipPath rect');
      const clipBefore = rect.outerHTML;
      const measure = () => [...svg.querySelectorAll('text')].map(text => {
        const matrix = svg.getScreenCTM().inverse().multiply(text.getScreenCTM());
        const box = text.getBBox();
        return {
          right: new DOMPoint(box.x + box.width, 0).matrixTransform(matrix).x,
          baseline: new DOMPoint(text.x.baseVal[0].value, text.y.baseVal[0].value).matrixTransform(matrix).y,
        };
      });
      const before = measure();
      const count = window.fitSvgCellText(svg);
      const after = measure();
      return { before, after, count, repeat: window.fitSvgCellText(svg), text: svg.textContent, clipBefore, clipAfter: rect.outerHTML };
    });
    assert.ok(result.before.at(-1).right > 29.5, 'the input must reproduce clipping');
    assert.equal(result.count, 1);
    assert.ok(result.after.every(glyph => glyph.right <= 29.5 + 0.001));
    assert.deepEqual(result.after.map(glyph => glyph.baseline), result.before.map(glyph => glyph.baseline));
    assert.equal(result.text, 'ABC');
    assert.equal(result.clipAfter, result.clipBefore);
    assert.equal(result.repeat, 0);
  });
});

test('fully outside glyphs and multi-character runs retain intentional clipping', async () => {
  for (const text of [glyphs(35), '<text x="0" y="25" font-size="16">A long unwrapped cell</text>']) {
    await withPage(fixture(text), async page => {
      const result = await page.evaluate(() => {
        const svg = document.querySelector('svg');
        const before = svg.outerHTML;
        return { count: window.fitSvgCellText(svg), before, after: svg.outerHTML };
      });
      assert.equal(result.count, 0);
      assert.equal(result.after, result.before);
    });
  }
});

test('nested clip intersections and display scaling share the same page coordinates', async () => {
  const markup = fixture().replace('<defs>', '<defs><clipPath id="body-clip-5"><rect width="27" height="60"/></clipPath>')
    .replace('<g clip-path=', '<g transform="translate(0 0)" clip-path="url(#body-clip-5)"><g clip-path=')
    .replace('</g></svg>', '</g></g></svg>');
  await withPage(markup, async page => {
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      svg.style.width = '60px';
      svg.style.height = '40px';
      const count = window.fitSvgCellText(svg);
      const last = svg.querySelector('text:last-child');
      const box = last.getBBox();
      const point = new DOMPoint(box.x + box.width, box.y).matrixTransform(svg.getScreenCTM().inverse().multiply(last.getScreenCTM()));
      return { count, right: point.x };
    });
    assert.equal(result.count, 1);
    assert.ok(result.right <= 27 + 0.001);
  });
});

test('rounded clips, rotated text and body text are not reinterpreted as cell ink tails', async () => {
  const cases = [
    fixture(glyphs(), '<rect width="29.5" height="50" rx="2"/>'),
    fixture(glyphs().replaceAll('<text ', '<text transform="rotate(10)" ')),
    fixture().replaceAll('cell-clip-8', 'body-clip-5'),
  ];
  for (const markup of cases) {
    await withPage(markup, async page => {
      const result = await page.evaluate(() => window.fitSvgCellText(document.querySelector('svg')));
      assert.equal(result, 0);
    });
  }
});

test('a mixed font line with a tall check mark still receives horizontal fitting', async () => {
  await withPage(fixture(glyphs().replace('>A</text>', '>✓</text>').replace('font-size="16"', 'font-size="32"')), async page => {
    assert.equal(await page.evaluate(() => window.fitSvgCellText(document.querySelector('svg'))), 1);
  });
});

test('intervening script runs keep their original text and paint order', async () => {
  const text = glyphs().replace('</text>', '</text><text x="12" y="12" font-size="8">2</text>');
  await withPage(fixture(text), async page => {
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      const before = svg.textContent;
      return { count: window.fitSvgCellText(svg), before, after: svg.textContent };
    });
    assert.equal(result.count, 1);
    assert.equal(result.before, 'A2BC');
    assert.equal(result.after, result.before);
  });
});

test('pending embedded fonts defer fitting until final font metrics are available', async () => {
  await withPage(fixture(), async page => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    await page.route('https://fonts.test/delayed.woff2', async route => {
      await blocked;
      await route.abort();
    });
    await page.evaluate(() => {
      const face = new FontFace('Delayed', 'url(https://fonts.test/delayed.woff2)');
      document.fonts.add(face);
      void face.load().catch(() => {});
    });
    await page.waitForFunction(() => document.fonts.status === 'loading');
    assert.equal(await page.evaluate(() => window.fitSvgCellText(document.querySelector('svg'))), 0);
    release();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => window.fitSvgCellText(document.querySelector('svg'))), 1);
  });
});
