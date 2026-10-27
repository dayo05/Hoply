type Rect = { left: number; right: number; top: number; bottom: number };
type Glyph = { element: SVGTextElement; bounds: Rect; originX: number };

/**
 * rhwp 0.8.7 can narrow a nested cell's clip after laying out its text. Browser
 * fallback glyphs can also overhang their metric advance. Fit a clipped final
 * glyph's line to the physical viewport, preserving the engine's line breaks.
 * Deliberate overflow (a glyph origin outside the cell) remains clipped.
 * The SVG must be connected so its browser font metrics and CTMs are available.
 */
export function fitSvgCellText(svg: SVGSVGElement): number {
  const fontsAreLoading = (): boolean => document.fonts.status === 'loading';
  if (!svg.isConnected || fontsAreLoading()) return 0;
  const screen = svg.getScreenCTM();
  if (!screen) return 0;
  const toPage = screen.inverse();
  const lines = new Map<Element, Map<number, { clip: Rect; glyphs: Glyph[] }>>();
  const transformRect = (box: DOMRect, matrix: DOMMatrix): Rect => {
    const start = new DOMPoint(box.x, box.y).matrixTransform(matrix);
    const end = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    return { left: start.x, right: end.x, top: start.y, bottom: end.y };
  };
  const horizontal = (matrix: DOMMatrix): boolean =>
    matrix.a > 0 && matrix.d > 0 && Math.abs(matrix.b) < 1e-9 && Math.abs(matrix.c) < 1e-9;
  const clipCache = new Map<Element, Rect | null>();

  const cellClip = (parent: Element): Rect | null => {
    if (clipCache.has(parent)) return clipCache.get(parent) ?? null;
    let clip = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
    let hasCell = false;
    for (let ancestor: Element | null = parent; ancestor && ancestor !== svg; ancestor = ancestor.parentElement) {
      const reference = ancestor.getAttribute('clip-path');
      if (!reference) continue;
      const id = /^url\(#([^)]*)\)$/.exec(reference)?.[1];
      const definition = id ? document.getElementById(id) : null;
      const rect = definition?.firstElementChild;
      // Do not reinterpret complex clips or objectBoundingBox coordinates.
      if (!id || definition?.closest('svg') !== svg || definition.getAttribute('clipPathUnits') === 'objectBoundingBox'
        || definition.children.length !== 1 || !(rect instanceof SVGRectElement)
        || definition.hasAttribute('transform') || rect.hasAttribute('transform')
        || rect.rx.baseVal.value !== 0 || rect.ry.baseVal.value !== 0) {
        clipCache.set(parent, null);
        return null;
      }
      const matrix = (ancestor as SVGGraphicsElement).getScreenCTM();
      if (!matrix || !horizontal(toPage.multiply(matrix))) {
        clipCache.set(parent, null);
        return null;
      }
      const bounds = transformRect(rect.getBBox(), toPage.multiply(matrix));
      clip = {
        left: Math.max(clip.left, bounds.left), right: Math.min(clip.right, bounds.right),
        top: Math.max(clip.top, bounds.top), bottom: Math.min(clip.bottom, bounds.bottom)
      };
      hasCell ||= /(?:^|-)cell-clip-/.test(id);
    }
    const result = hasCell && clip.right > clip.left && clip.bottom > clip.top ? clip : null;
    clipCache.set(parent, result);
    return result;
  };

  // Read all geometry before writing transforms; avoid a layout pass per glyph.
  for (const text of svg.querySelectorAll('text')) {
    if (!(text instanceof SVGTextElement)) continue;
    const parent = text.parentElement;
    if (!parent) continue;
    const clip = cellClip(parent);
    if (!clip) continue;
    const matrix = text.getScreenCTM();
    if (!matrix || !horizontal(toPage.multiply(matrix))) continue;
    const pageMatrix = toPage.multiply(matrix);
    const origin = new DOMPoint(
      text.x.baseVal.numberOfItems ? text.x.baseVal.getItem(0).value : 0,
      text.y.baseVal.numberOfItems ? text.y.baseVal.getItem(0).value : 0
    )
      .matrixTransform(pageMatrix);
    // Quantize only floating point noise when grouping a common baseline.
    const baseline = Math.round(origin.y * 1e6) / 1e6;
    let parentLines = lines.get(parent);
    if (!parentLines) { parentLines = new Map(); lines.set(parent, parentLines); }
    let line = parentLines.get(baseline);
    if (!line) { line = { clip, glyphs: [] }; parentLines.set(baseline, line); }
    line.glyphs.push({ element: text, bounds: transformRect(text.getBBox(), pageMatrix), originX: origin.x });
  }

  // Measuring an SVG with embedded faces can itself start a font load. Retry
  // after FontFaceSet.ready instead of freezing the temporary fallback metrics.
  if (fontsAreLoading()) return 0;

  let corrected = 0;
  for (const [parent, parentLines] of lines) {
    const parentMatrix = (parent as SVGGraphicsElement).getScreenCTM();
    if (!parentMatrix) continue;
    const pageToParent = toPage.multiply(parentMatrix).inverse();
    for (const [baseline, { clip, glyphs }] of parentLines) {
      const left = Math.max(clip.left, Math.min(...glyphs.map(glyph => glyph.bounds.left)));
      const right = Math.max(...glyphs.map(glyph => glyph.bounds.right));
      // A whole missing glyph, multi-character run, RTL/anchored text or clipped
      // continuation is a different layout contract, not a terminal ink tail.
      if (right <= clip.right + 1e-3 || right <= left || baseline < clip.top || baseline > clip.bottom
        || glyphs.some(({ element, originX }) =>
          originX < clip.left || originX >= clip.right || element.children.length > 0
          || element.rotate.baseVal.numberOfItems > 0 || element.x.baseVal.numberOfItems > 1 || element.y.baseVal.numberOfItems > 1
          || Array.from(element.textContent ?? '').length !== 1
          || getComputedStyle(element).direction !== 'ltr'
          || getComputedStyle(element).textAnchor !== 'start'
          || getComputedStyle(element).writingMode !== 'horizontal-tb')) continue;

      const localLeft = new DOMPoint(left, 0).matrixTransform(pageToParent).x;
      const scale = (clip.right - left) / (right - left);
      if (!Number.isFinite(scale) || scale <= 0 || scale >= 1) continue;
      const transform = `translate(${localLeft} 0) scale(${scale} 1) translate(${-localLeft} 0)`;
      // Keep DOM/paint order, including intervening decorations and script runs.
      for (const { element } of glyphs) {
        element.setAttribute('transform', `${transform} ${element.getAttribute('transform') ?? ''}`.trim());
        element.setAttribute('data-rhwp-cell-text-fit', '');
      }
      corrected += 1;
    }
  }
  return corrected;
}
