import { HwpDocument } from '@rhwp/core';
import { splitFixedPages, hwp5Template, type PageSize } from './hwp-fixed-container';
import { layoutText, type EditItem } from './simple-edit-model';

const json = (s: string): Record<string, any> => { const value = JSON.parse(s); if (value.ok === false || value.error) throw new Error(value.error ?? 'HWP 생성 실패'); return value; };
const hu = (px: number): number => Math.round(px * 75);
const fixed = (x: number, y: number) => ({ treatAsChar: false, textWrap: 'InFrontOfText', vertRelTo: 'Paper', horzRelTo: 'Paper', vertAlign: 'Top', horzAlign: 'Left', vertOffset: hu(y), horzOffset: hu(x), allowOverlap: true, restrictInPage: false, sizeProtect: true, outerMarginLeft: 0, outerMarginTop: 0, outerMarginRight: 0, outerMarginBottom: 0 });
type FrozenPage = PageSize & { png: Uint8Array; pixelsWide: number; pixelsHigh: number };
const backgrounds = new WeakMap<HwpDocument, Promise<FrozenPage[]>>();

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(3, Math.sqrt(12_000_000 / (width * height)), 8192 / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale)); return canvas;
}
async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('페이지 이미지를 만들 수 없습니다.')), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer()); canvas.width = canvas.height = 1; return bytes;
}

/** Freeze the displayed form, including page-local clips and glyph fitting. */
export async function freezePage(source: string): Promise<FrozenPage> {
  const root = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
  const values = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (root.localName !== 'svg' || !values || values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) throw new Error('쪽 크기를 확인할 수 없습니다.');
  const [,, width, height] = values;
  root.setAttribute('width', String(width)); root.setAttribute('height', String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml;charset=utf-8' }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('양식 배경을 읽을 수 없습니다.')); image.src = url; });
    const canvas = newCanvas(width, height), pixelsWide = canvas.width, pixelsHigh = canvas.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('페이지 그리기 메모리가 부족합니다.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { width, height, pixelsWide, pixelsHigh, png: await pngBytes(canvas) };
  } finally { image.onload = image.onerror = null; image.removeAttribute('src'); URL.revokeObjectURL(url); }
}

export async function exportSimpleHwp(originalDocument: HwpDocument, items: EditItem[], sourcePages: string[]): Promise<Uint8Array> {
  if (sourcePages.length !== originalDocument.pageCount()) throw new Error('아직 모든 쪽을 준비하지 못했습니다.');
  let frozen = backgrounds.get(originalDocument);
  if (!frozen) {
    frozen = (async () => { const result: FrozenPage[] = []; for (const page of sourcePages) result.push(await freezePage(page)); return result; })();
    backgrounds.set(originalDocument, frozen);
    void frozen.catch(() => backgrounds.delete(originalDocument));
  }
  const pages = await frozen;
  const blank = HwpDocument.createEmpty();
  let work: HwpDocument;
  try { work = new HwpDocument(hwp5Template(blank.exportHwp())); } finally { blank.free(); }
  let reloaded: HwpDocument | undefined;
  try {
    const fontId = work.findOrCreateFontId('맑은 고딕');
    if (fontId < 0) throw new Error('입력 글꼴을 준비하지 못했습니다.');
    json(work.setPageDef(0, JSON.stringify({ width: hu(pages[0].width), height: hu(pages[0].height), marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, marginHeader: 0, marginFooter: 0, marginGutter: 0 })));
    // insertParagraph inserts a blank before the existing host and moves its
    // controls forward. Allocate all hosts before placing any page objects.
    for (let page = 1; page < pages.length; page++) json(work.insertParagraph(0, 0));
    for (let page = 0; page < pages.length; page++) {
      const background = pages[page];
      const result = json(work.insertPicture(0, page, 0, '[]', background.png, hu(background.width), hu(background.height), background.pixelsWide, background.pixelsHigh, 'png', `HoplyBackground:${page}:page`));
      // Pictures do not expose zOrder through this API. BehindText guarantees
      // that native textboxes remain visible above the opaque page background.
      json(work.setPictureProperties(0, result.paraIdx, result.controlIdx, JSON.stringify({ ...fixed(0, 0), textWrap: 'BehindText' })));
      for (const item of items.filter(i => i.page === page)) {
        if (item.kind === 'text') {
          const context = document.createElement('canvas').getContext('2d')!; context.font = `${item.fontSize}px sans-serif`;
          const lines = layoutText(item.text, item.rect, item.fontSize, s => context.measureText(s).width);
          if (!lines) throw new Error('입력한 내용이 고정 영역을 넘습니다.');
          lines.forEach((line, index) => {
            if (!line) return;
            const box = json(work.createShapeControl(JSON.stringify({ sectionIdx: 0, paraIdx: page, charOffset: work.getParagraphLength(0, page), shapeType: 'textbox', width: hu(item.rect.width - 8), height: hu(item.fontSize * 1.3), horzOffset: hu(item.rect.x + 4), vertOffset: hu(item.rect.y + 4 + index * item.fontSize * 1.3), treatAsChar: false, textWrap: 'InFrontOfText' })));
            json(work.setShapeProperties(0, box.paraIdx, box.controlIdx, JSON.stringify({ ...fixed(item.rect.x + 4, item.rect.y + 4 + index * item.fontSize * 1.3), description: `HoplyInput:${item.id}:${index}:text`, lineType: 0, fillType: 'solid', fillAlpha: 255, tbMarginLeft: 0, tbMarginRight: 0, tbMarginTop: 0, tbMarginBottom: 0, tbVerticalAlign: 'Top' })));
            json(work.insertTextInCell(0, box.paraIdx, box.controlIdx, 0, 0, 0, line));
            json(work.applyCharFormatInCell(0, box.paraIdx, box.controlIdx, 0, 0, 0, line.length, JSON.stringify({ fontId, fontSize: hu(item.fontSize), textColor: parseInt(item.color.slice(1), 16), bold: false, italic: false })));
            json(work.applyParaFormatInCell(0, box.paraIdx, box.controlIdx, 0, 0, JSON.stringify({ alignment: 'left', marginLeft: 0, marginRight: 0, indent: 0, spaceBefore: 0, spaceAfter: 0 })));
          });
        } else {
          const canvas = newCanvas(item.rect.width, item.rect.height), context = canvas.getContext('2d')!;
          const pixelsWide = canvas.width, pixelsHigh = canvas.height;
          context.scale(pixelsWide / item.rect.width, pixelsHigh / item.rect.height); context.lineWidth = item.width; context.strokeStyle = item.color; context.lineCap = 'round'; context.lineJoin = 'round';
          context.beginPath(); item.points.forEach((p, i) => i ? context.lineTo(p.x - item.rect.x, p.y - item.rect.y) : context.moveTo(p.x - item.rect.x, p.y - item.rect.y));
          if (item.points.length === 1) context.lineTo(item.points[0].x - item.rect.x + 0.01, item.points[0].y - item.rect.y);
          context.stroke();
          const result = json(work.insertPicture(0, page, work.getParagraphLength(0, page), '[]', await pngBytes(canvas), hu(item.rect.width), hu(item.rect.height), pixelsWide, pixelsHigh, 'png', `HoplyInput:${item.id}:ink`));
          json(work.setPictureProperties(0, result.paraIdx, result.controlIdx, JSON.stringify(fixed(item.rect.x, item.rect.y))));
        }
      }
    }
    const exported = work.exportHwpWithReport();
    let generated: Uint8Array;
    try { if (json(exported.contentLoss()).count) throw new Error('새 HWP를 만드는 과정에서 내용 손실이 있습니다.'); generated = exported.takeBytes(); } finally { exported.free(); }
    const bytes = splitFixedPages(generated, pages);
    reloaded = new HwpDocument(bytes);
    if (reloaded.pageCount() !== pages.length) throw new Error('작성본의 쪽 수가 다릅니다.');
    for (let page = 0; page < pages.length; page++) {
      const info = json(reloaded.getPageInfo(page));
      if (Math.abs(info.width - pages[page].width) > .06 || Math.abs(info.height - pages[page].height) > .06) throw new Error('작성본의 용지 크기가 다릅니다.');
      const controls = json(reloaded.getPageControlLayout(page)).controls as Record<string, any>[];
      const background = controls.find(c => c.type === 'image' && json(reloaded!.getPictureProperties(c.secIdx, c.paraIdx, c.controlIdx)).description === `HoplyBackground:${page}:page`);
      if (!background || background.wrap !== 'behindText' || Math.abs(background.x) > .06 || Math.abs(background.y) > .06 || Math.abs(background.w - pages[page].width) > .06 || Math.abs(background.h - pages[page].height) > .06) throw new Error(`작성본 ${page + 1}쪽의 양식 배경 위치가 다릅니다.`);
      const png = reloaded.getControlImageData(background.secIdx, background.paraIdx, '[]', background.controlIdx);
      if (png.length !== pages[page].png.length || png.some((v, i) => v !== pages[page].png[i])) throw new Error('작성본의 양식 배경 데이터가 다릅니다.');
    }
    return bytes;
  } finally { work.free(); reloaded?.free(); }
}
