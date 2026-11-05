import { HwpDocument } from '@rhwp/core';
import { graftHwpObjects, type AddedControl, type CellPathEntry } from './hwp-record-overlay';
import { layoutText, type EditItem } from './simple-edit-model';

const json = (value: string): Record<string, any> => {
  const parsed = JSON.parse(value);
  if (parsed.ok === false || parsed.error) throw new Error(parsed.error ?? 'HWP 개체 처리에 실패했습니다.');
  return parsed;
};
const hu = (pixels: number): number => Math.round(pixels * 75);
const fixed = (rect: EditItem['rect']) => ({ treatAsChar: false, textWrap: 'InFrontOfText', vertRelTo: 'Paper', horzRelTo: 'Paper', vertAlign: 'Top', horzAlign: 'Left', vertOffset: hu(rect.y), horzOffset: hu(rect.x), allowOverlap: true, restrictInPage: false, sizeProtect: false, outerMarginLeft: 0, outerMarginRight: 0, outerMarginTop: 0, outerMarginBottom: 0 });

/** Canonical paint includes inherited transforms/clips and paint order. */
export function pagePaint(source: string): string[] {
  const root = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
  if (root.localName !== 'svg' || root.querySelector('parsererror')) throw new Error('페이지 비교용 SVG를 읽을 수 없습니다.');
  const ids = new Map([...root.querySelectorAll('[id]')].map(e => [e.id, e]));
  const number = (s: string): string => s.replace(/-?\d+\.\d+(?:e[+-]?\d+)?/gi, v => String(Math.round(Number(v) * 10000) / 10000));
  const attributes = (el: Element, depth = 0): string => [...el.attributes].filter(a => a.name !== 'id').sort((a, b) => a.name.localeCompare(b.name)).map(a => {
    let value = a.value;
    if (depth < 5) value = value.replace(/url\(#([^)]*)\)/g, (_, id: string) => {
      const target = ids.get(id);
      return target ? `ref(${target.localName}:${attributes(target, depth + 1)}:${[...target.children].map(e => `${e.localName}:${attributes(e, depth + 1)}`).join(';')})` : 'missing-ref';
    });
    return `${a.name}=${a.name === 'href' || a.name === 'xlink:href' ? value : number(value)}`;
  }).join('|');
  const paint: string[] = [];
  const walk = (element: Element, ancestors: string[]): void => {
    if (['defs', 'style', 'title', 'desc', 'metadata'].includes(element.localName)) return;
    const signature = `${element.localName}[${attributes(element)}]`;
    if (['text', 'rect', 'path', 'line', 'polygon', 'polyline', 'circle', 'ellipse', 'image', 'use', 'foreignObject'].includes(element.localName)) paint.push([...ancestors, signature, element.textContent ?? ''].join('>'));
    else for (const child of element.children) walk(child, [...ancestors, signature]);
  };
  walk(root, []);
  return paint;
}

export function assertOriginalPaint(before: string[], after: string[]): void {
  let matched = 0;
  for (const operation of after) if (operation === before[matched]) matched++;
  if (matched !== before.length) throw new Error('기존 문서의 렌더링이 달라졌습니다. HWP 저장을 완료하지 못했습니다.');
}

export function exportSimpleHwp(original: Uint8Array, items: EditItem[], originalDocument: HwpDocument): Uint8Array {
  try { return attemptSimpleHwp(original, items, originalDocument, false); }
  catch (error) {
    // A paragraph at the page end can trigger a legacy stored-line fallback.
    // Retry using a paragraph at the page start, with the same paint checks.
    if (!(error instanceof Error) || !/기존 문서의 렌더링|저장 후 쪽 수/.test(error.message)) throw error;
    try { return attemptSimpleHwp(original, items, originalDocument, true); }
    catch (retryError) {
      if (!(retryError instanceof Error) || !/기존 문서의 렌더링|저장 후 쪽 수/.test(retryError.message)) throw retryError;
      return attemptSimpleHwp(original, items, originalDocument, false, true);
    }
  }
}

function attemptSimpleHwp(original: Uint8Array, items: EditItem[], originalDocument: HwpDocument, preferFirst: boolean, useCells = false): Uint8Array {
  if (items.length === 0) return original.slice();
  const work = new HwpDocument(original);
  let reloaded: HwpDocument | undefined;
  try {
    const baselineResult = work.exportHwpWithReport();
    let baseline: Uint8Array, baselineLoss: string;
    try { baselineLoss = baselineResult.contentLoss(); baseline = baselineResult.takeBytes(); } finally { baselineResult.free(); }
    const added: AddedControl[] = [];
    type Anchor = { section: number; paragraph: number; preserveText?: boolean; cellPath?: CellPathEntry[] };
    const anchors = new Map<number, Anchor>();
    for (const page of new Set(items.map(i => i.page))) {
      const runs = json(originalDocument.getPageTextLayout(page)).runs as Record<string, any>[];
      const orderedRuns = preferFirst ? runs : [...runs].reverse();
      const run = orderedRuns.find(r => r.cellIdx === undefined && Number.isInteger(r.secIdx) && Number.isInteger(r.paraIdx) && json(originalDocument.getCursorRect(r.secIdx, r.paraIdx, 0)).pageIndex === page);
      let anchor: Anchor | undefined;
      if (useCells) {
        const cell = [...runs].reverse().find(r => r.cellPath?.length && Number.isInteger(r.parentParaIdx) && json(originalDocument.getCursorRectByPath(r.secIdx, r.parentParaIdx, JSON.stringify(r.cellPath), 0)).pageIndex === page);
        if (cell) anchor = { section: cell.secIdx, paragraph: cell.parentParaIdx, cellPath: cell.cellPath, preserveText: true };
      }
      const controls = json(originalDocument.getPageControlLayout(page)).controls as Record<string, any>[];
      const table = controls.find(c => c.type === 'table' && !c.headerFooter && c.stableIndex?.length === 3 && originalDocument.getParagraphLength(c.secIdx, c.paraIdx) === 0 && json(originalDocument.getCursorRect(c.secIdx, c.paraIdx, 0)).pageIndex === page);
      // Use the native floating-in-cell contract: a textless table host already
      // has controls, and adding a sibling must not alter its inline counts.
      if (!anchor && table && !preferFirst) anchor = { section: table.secIdx, paragraph: table.paraIdx, preserveText: true };
      else if (!anchor && run) anchor = { section: run.secIdx, paragraph: run.paraIdx };
      if (!anchor) {
        // Pages made entirely of a table need not expose a body text run.
        // Their host paragraph still has a page cursor in the native model.
        const section = json(originalDocument.getPageInfo(page)).sectionIndex;
        const count = originalDocument.getParagraphCount(section);
        for (let index = 0; index < count; index++) {
          const paragraph = preferFirst ? index : count - 1 - index;
          try { if (json(originalDocument.getCursorRect(section, paragraph, 0)).pageIndex === page) { anchor = { section, paragraph }; break; } } catch { /* no body cursor */ }
        }
      }
      if (!anchor) throw new Error(`${page + 1}쪽의 고정 개체 연결 위치를 찾지 못했습니다.`);
      anchors.set(page, anchor);
    }
    for (const item of items) {
      const { section, paragraph, preserveText, cellPath } = anchors.get(item.page)!;
      if (item.kind === 'text') {
        const context = document.createElement('canvas').getContext('2d')!; context.font = `${item.fontSize}px sans-serif`;
        const lines = layoutText(item.text, item.rect, item.fontSize, s => context.measureText(s).width);
        if (!lines) throw new Error('입력한 내용이 고정 영역을 넘습니다.');
        lines.forEach((line, index) => {
          if (!line) return;
          const token = `HoplySimpleEdit:${item.id}:${index}:text`;
          const rect = { x: item.rect.x + 4, y: item.rect.y + 4 + index * item.fontSize * 1.3, width: item.rect.width - 8, height: item.fontSize * 1.3 };
          const result = json(work.createShapeControl(JSON.stringify({ sectionIdx: section, paraIdx: paragraph, charOffset: work.getParagraphLength(section, paragraph), shapeType: 'textbox', width: hu(rect.width), height: hu(rect.height), horzOffset: hu(rect.x), vertOffset: hu(rect.y), treatAsChar: false, textWrap: 'InFrontOfText' })));
          json(work.setShapeProperties(section, result.paraIdx, result.controlIdx, JSON.stringify({ ...fixed(rect), description: token, lineType: 0, fillType: 'solid', fillAlpha: 255, tbMarginLeft: 0, tbMarginRight: 0, tbMarginTop: 0, tbMarginBottom: 0 })));
          json(work.insertTextInCell(section, result.paraIdx, result.controlIdx, 0, 0, 0, line));
          json(work.applyCharFormatInCell(section, result.paraIdx, result.controlIdx, 0, 0, 0, line.length, JSON.stringify({ fontSize: hu(item.fontSize), textColor: parseInt(item.color.slice(1), 16), bold: false, italic: false })));
          json(work.applyParaFormatInCell(section, result.paraIdx, result.controlIdx, 0, 0, JSON.stringify({ alignment: 'left', marginLeft: 0, marginRight: 0, indent: 0, spaceBefore: 0, spaceAfter: 0 })));
          added.push({ section, paragraph, token, preserveText, cellPath });
        });
      } else {
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(item.rect.width * 3); canvas.height = Math.ceil(item.rect.height * 3);
        const context = canvas.getContext('2d')!; context.scale(3, 3); context.strokeStyle = item.color; context.lineWidth = item.width; context.lineCap = 'round'; context.lineJoin = 'round';
        context.beginPath(); item.points.forEach((point, i) => i ? context.lineTo(point.x - item.rect.x, point.y - item.rect.y) : context.moveTo(point.x - item.rect.x, point.y - item.rect.y));
        if (item.points.length === 1) context.lineTo(item.points[0].x - item.rect.x + 0.01, item.points[0].y - item.rect.y);
        context.stroke();
        const data = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
        const token = `HoplySimpleEdit:${item.id}:ink`;
        const result = json(work.insertPicture(section, paragraph, work.getParagraphLength(section, paragraph), '[]', data, hu(item.rect.width), hu(item.rect.height), canvas.width, canvas.height, 'png', token));
        json(work.setPictureProperties(section, result.paraIdx, result.controlIdx, JSON.stringify(fixed(item.rect))));
        added.push({ section, paragraph, token, preserveText, cellPath });
      }
    }
    const result = work.exportHwpWithReport();
    let generated: Uint8Array;
    try {
      // Existing unknown controls remain in their original raw streams. Only a
      // newly introduced serializer loss is relevant to the object graft.
      if (result.contentLoss() !== baselineLoss) throw new Error('HWP 개체 생성 과정에 새 내용 손실이 있습니다.');
      generated = result.takeBytes();
    } finally { result.free(); }
    const bytes = graftHwpObjects(original, baseline, generated, added);
    reloaded = new HwpDocument(bytes);
    if (reloaded.pageCount() !== originalDocument.pageCount()) throw new Error('저장 후 쪽 수가 달라졌습니다.');
    for (let page = 0; page < originalDocument.pageCount(); page++) assertOriginalPaint(pagePaint(originalDocument.renderPageSvg(page)), pagePaint(reloaded.renderPageSvg(page)));
    return bytes;
  } finally { reloaded?.free(); work.free(); }
}
