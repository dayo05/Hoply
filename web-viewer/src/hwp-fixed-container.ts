import * as CFB from 'cfb';
import { deflateSync, inflateSync } from 'fflate';

export type PageSize = { width: number; height: number };
type Rec = { tag: number; level: number; data: Uint8Array };
const dv = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; } return out;
};
function parse(bytes: Uint8Array): Rec[] {
  let offset = 0; const result: Rec[] = [];
  while (offset < bytes.length) {
    const header = dv(bytes).getUint32(offset, true); offset += 4;
    let length = header >>> 20;
    if (length === 4095) { length = dv(bytes).getUint32(offset, true); offset += 4; }
    if (offset + length > bytes.length) throw new Error('HWP 기록 길이가 올바르지 않습니다.');
    result.push({ tag: header & 1023, level: (header >>> 10) & 1023, data: bytes.slice(offset, offset + length) }); offset += length;
  }
  return result;
}
function encode(r: Rec): Uint8Array {
  const header = new Uint8Array(r.data.length >= 4095 ? 8 : 4);
  dv(header).setUint32(0, ((Math.min(r.data.length, 4095) << 20) | (r.level << 10) | r.tag) >>> 0, true);
  if (header.length === 8) dv(header).setUint32(4, r.data.length, true);
  return concat([header, r.data]);
}

/** createEmpty's template has a zero version. Normalize it before generating
 * content so the serializer and third-party HWP readers agree on HWP 5. */
export function hwp5Template(bytes: Uint8Array): Uint8Array {
  const container = CFB.read(bytes, { type: 'array' });
  const entry = CFB.find(container, '/FileHeader');
  if (!entry) throw new Error('HWP 파일 헤더가 없습니다.');
  const header = new Uint8Array(entry.content);
  dv(header).setUint32(32, 0x05010100, true);
  CFB.utils.cfb_add(container, '/FileHeader', header);
  const result = new Uint8Array(CFB.write(container, { type: 'array', fileType: 'cfb' }));
  normalizeCfbAllocation(result); return result;
}

/** SheetJS pads unused allocation entries with ENDOFCHAIN. CFB requires
 * FREESECT for unallocated sectors; strict readers reject the former. */
export function normalizeCfbAllocation(bytes: Uint8Array): void {
  const data = dv(bytes), sectorSize = 2 ** data.getUint16(30, true), perSector = sectorSize / 4;
  const sectorCount = bytes.length / sectorSize - 1;
  const free = 0xffffffff, end = 0xfffffffe;
  const sectorOffset = (sector: number): number => {
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) throw new Error('CFB 할당 섹터가 범위를 벗어났습니다.');
    return (sector + 1) * sectorSize;
  };
  const fat: number[] = [];
  const fatCount = data.getUint32(44, true);
  for (let i = 0; i < 109 && fat.length < fatCount; i++) { const sector = data.getUint32(76 + 4 * i, true); if (sector !== free) fat.push(sector); }
  let difat = data.getUint32(68, true);
  for (let block = 0; block < data.getUint32(72, true) && fat.length < fatCount; block++) {
    const offset = sectorOffset(difat);
    for (let i = 0; i < perSector - 1 && fat.length < fatCount; i++) { const sector = data.getUint32(offset + 4 * i, true); if (sector !== free) fat.push(sector); }
    difat = data.getUint32(offset + sectorSize - 4, true);
  }
  if (fat.length !== fatCount) throw new Error('CFB FAT 개수가 일치하지 않습니다.');
  const fatOffset = (index: number): number => sectorOffset(fat[Math.floor(index / perSector)]) + 4 * (index % perSector);
  for (let index = sectorCount; index < fat.length * perSector; index++) data.setUint32(fatOffset(index), free, true);
  const directory = sectorOffset(data.getUint32(48, true));
  const rootSize = Number(data.getBigUint64(directory + 120, true));
  const miniCount = Math.ceil(rootSize / 2 ** data.getUint16(32, true));
  let miniFat = data.getUint32(60, true);
  for (let block = 0; block < data.getUint32(64, true) && miniFat !== end; block++) {
    const offset = sectorOffset(miniFat);
    for (let i = 0; i < perSector; i++) if (block * perSector + i >= miniCount) data.setUint32(offset + 4 * i, free, true);
    miniFat = data.getUint32(fatOffset(miniFat), true);
  }
}


/** Each source page gets its own section, including mixed paper sizes.
 * The generator owns all resource IDs; only section framing is changed. */
export function splitFixedPages(generated: Uint8Array, pages: PageSize[]): Uint8Array {
  if (!pages.length || pages.length > 65535) throw new Error('쪽 수가 올바르지 않습니다.');
  const container = CFB.read(generated, { type: 'array' });
  const read = (path: string): Uint8Array => {
    const entry = CFB.find(container, '/' + path); if (!entry) throw new Error(`HWP 기록이 없습니다: ${path}`); return new Uint8Array(entry.content);
  };
  const header = read('FileHeader');
  const compressed = (dv(header).getUint32(36, true) & 1) !== 0;
  const decode = (b: Uint8Array): Uint8Array => compressed ? inflateSync(b) : b;
  const pack = (b: Uint8Array): Uint8Array => compressed ? deflateSync(b) : b;
  const records = parse(decode(read('BodyText/Section0')));
  const starts = records.flatMap((r, i) => r.tag === 66 && r.level === 0 ? [i] : []);
  if (starts.length !== pages.length) throw new Error('고정 페이지의 문단 수가 다릅니다.');
  const first = records.slice(starts[0], starts[1] ?? records.length);
  const sectionControls: Rec[] = [];
  const firstView = dv(first[0].data);
  for (let index = 1; index < first.length; index++) {
    const r = first[index];
    if (r.tag !== 71 || r.level !== 1 || ![0x73656364, 0x636f6c64].includes(dv(r.data).getUint32(0, true))) continue;
    let end = index + 1; while (end < first.length && first[end].level > 1) end++;
    sectionControls.push(...first.slice(index, end)); index = end - 1;
  }
  if (!sectionControls.some(r => r.tag === 73)) throw new Error('고정 페이지의 용지 정의가 없습니다.');
  for (let page = 0; page < pages.length; page++) {
    const content = records.slice(starts[page], starts[page + 1] ?? records.length);
    const shapes: Rec[] = [];
    for (let index = 1; index < content.length; index++) {
      const r = content[index];
      if (r.tag !== 71 || r.level !== 1 || dv(r.data).getUint32(0, true) !== 0x67736f20) continue;
      let end = index + 1; while (end < content.length && content[end].level > 1) end++;
      shapes.push(...content.slice(index, end)); index = end - 1;
    }
    const controlCount = shapes.filter(r => r.tag === 71 && r.level === 1).length;
    const common = sectionControls.map(r => ({ ...r, data: r.data.slice() }));
    const pageDef = common.find(r => r.tag === 73)!;
    dv(pageDef.data).setUint32(0, Math.round(pages[page].width * 75), true);
    dv(pageDef.data).setUint32(4, Math.round(pages[page].height * 75), true);
    for (let offset = 8; offset < 40; offset += 4) dv(pageDef.data).setUint32(offset, 0, true);
    const para = { ...content[0], data: content[0].data.slice() };
    dv(para.data).setUint32(0, (0x80000000 | (16 + controlCount * 8 + 1)) >>> 0, true);
    dv(para.data).setUint32(4, firstView.getUint32(4, true) | 0x800, true);
    // The generated host contains no inline text. Section/column definitions and
    // floating GSO markers form its complete, explicit text representation.
    const marker = (code: number, id: number): Uint8Array => { const b = new Uint8Array(16); dv(b).setUint16(0, code, true); dv(b).setUint32(2, id, true); dv(b).setUint16(14, code, true); return b; };
    const text = concat([marker(2, 0x73656364), marker(2, 0x636f6c64), ...Array.from({ length: controlCount }, () => marker(11, 0x67736f20)), new Uint8Array([13, 0])]);
    const prefix = content.filter((r, i) => i > 0 && r.level === 1 && [68, 69, 70].includes(r.tag));
    const section = [para, { tag: 67, level: 1, data: text }, ...prefix, ...common, ...shapes];
    CFB.utils.cfb_add(container, `/BodyText/Section${page}`, pack(concat(section.map(encode))));
  }
  const info = parse(decode(read('DocInfo')));
  const properties = info.find(r => r.tag === 16)!;
  dv(properties.data).setUint16(0, pages.length, true);
  CFB.utils.cfb_add(container, '/DocInfo', pack(concat(info.map(encode))));
  const result = new Uint8Array(CFB.write(container, { type: 'array', fileType: 'cfb' }));
  normalizeCfbAllocation(result);
  return result;
}
