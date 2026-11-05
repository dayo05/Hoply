export type EditRect = { x: number; y: number; width: number; height: number };
export type EditPoint = { x: number; y: number; pressure: number };
export type EditItem = { id: string; page: number; rect: EditRect; color: string } & (
  | { kind: 'text'; text: string; fontSize: number }
  | { kind: 'ink'; points: EditPoint[]; width: number }
);
export type EditState = { schema: 1; items: EditItem[]; renderer?: string; layout?: string };

/** Page coordinates, never screen coordinates. No document model is writable here. */
export function validateEdits(value: unknown, pageCount: number): EditState {
  const data = value as EditState;
  if (!data || data.schema !== 1 || !Array.isArray(data.items) || data.items.length > 2000) throw new Error('편집 데이터 형식이 올바르지 않습니다.');
  const ids = new Set<string>();
  for (const item of data.items) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || !Number.isInteger(item.page) || item.page < 0 || item.page >= pageCount
      || !/^#[0-9a-f]{6}$/i.test(item.color) || !item.rect
      || !Object.values(item.rect).every(Number.isFinite) || item.rect.x < 0 || item.rect.y < 0 || item.rect.width <= 0 || item.rect.height <= 0) throw new Error('편집 위치가 올바르지 않습니다.');
    ids.add(item.id);
    if (item.kind === 'text') {
      if (typeof item.text !== 'string' || item.text.length > 10000 || !Number.isFinite(item.fontSize) || item.fontSize < 6 || item.fontSize > 72) throw new Error('입력한 글자를 확인해 주세요.');
    } else if (item.kind === 'ink') {
      if (!Array.isArray(item.points) || item.points.length < 1 || item.points.length > 20000 || !Number.isFinite(item.width) || item.width <= 0 || item.width > 20
        || item.points.some(p => ![p.x, p.y, p.pressure].every(Number.isFinite) || p.pressure < 0 || p.pressure > 1)) throw new Error('필기 데이터를 확인해 주세요.');
    } else throw new Error('지원하지 않는 편집입니다.');
  }
  return structuredClone(data);
}

export function inside(rect: EditRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

/** Wrap only the new text, never the form. The box and font size stay fixed. */
export function layoutText(text: string, rect: EditRect, fontSize: number, measure: (s: string) => number): string[] | null {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (measure(character) > rect.width - 8) return null;
      if (measure(line + character) > rect.width - 8) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  return lines.length * fontSize * 1.3 <= rect.height - 8 ? lines : null;
}
