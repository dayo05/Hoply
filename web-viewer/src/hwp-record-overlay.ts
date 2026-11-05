import * as CFB from 'cfb';
import { deflateSync, inflateSync } from 'fflate';

type RecordData = { tag: number; level: number; data: Uint8Array; raw: Uint8Array };
export type CellPathEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };
export type AddedControl = { section: number; paragraph: number; token: string; preserveText?: boolean; cellPath?: CellPathEntry[] };
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const join = (parts: Uint8Array[]): Uint8Array => { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };

function records(bytes: Uint8Array): RecordData[] {
  const result: RecordData[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (offset + 4 > bytes.length) throw new Error('HWP 레코드 헤더가 잘렸습니다.');
    const header = view(bytes).getUint32(offset, true); offset += 4;
    let size = header >>> 20;
    if (size === 4095) { if (offset + 4 > bytes.length) throw new Error('HWP 길이 정보가 잘렸습니다.'); size = view(bytes).getUint32(offset, true); offset += 4; }
    if (offset + size > bytes.length) throw new Error('HWP 레코드가 잘렸습니다.');
    result.push({ tag: header & 1023, level: (header >>> 10) & 1023, data: bytes.slice(offset, offset + size), raw: bytes.slice(start, offset + size) });
    offset += size;
  }
  return result;
}
function encode(record: RecordData): Uint8Array {
  const header = new Uint8Array(record.data.length >= 4095 ? 8 : 4);
  view(header).setUint32(0, ((Math.min(record.data.length, 4095) << 20) | (record.level << 10) | record.tag) >>> 0, true);
  if (header.length === 8) view(header).setUint32(4, record.data.length, true);
  return join([header, record.data]);
}

/** SheetJS pads unused allocation entries with ENDOFCHAIN. CFB requires
 * FREESECT for unallocated sectors; strict readers reject the former. */
export function normalizeCfbAllocation(bytes: Uint8Array): void {
  const data = view(bytes), sectorSize = 2 ** data.getUint16(30, true), perSector = sectorSize / 4;
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

/** Copy source streams, graft only new non-flowing objects. Never reserialize a source table. */
export function graftHwpObjects(original: Uint8Array, baselineExport: Uint8Array, generated: Uint8Array, added: AddedControl[]): Uint8Array {
  const source = CFB.read(original, { type: 'array' });
  const baseline = CFB.read(baselineExport, { type: 'array' });
  const edited = CFB.read(generated, { type: 'array' });
  const read = (container: CFB.CFB$Container, path: string): Uint8Array => {
    const entry = CFB.find(container, '/' + path);
    if (!entry || entry.type !== 2) throw new Error(`HWP 스트림이 없습니다: ${path}`);
    return new Uint8Array(entry.content);
  };
  const header = read(source, 'FileHeader');
  if (new TextDecoder().decode(header.slice(0, 17)) !== 'HWP Document File' || (view(header).getUint32(36, true) & 0x06)) throw new Error('암호화·배포용 문서는 편집할 수 없습니다.');
  const compressed = (view(header).getUint32(36, true) & 1) !== 0;
  const decode = (bytes: Uint8Array): Uint8Array => compressed ? inflateSync(bytes) : bytes;
  const pack = (bytes: Uint8Array): Uint8Array => compressed ? deflateSync(bytes) : bytes;
  const genCompressed = (view(read(edited, 'FileHeader')).getUint32(36, true) & 1) !== 0;
  const genDecode = (bytes: Uint8Array): Uint8Array => genCompressed ? inflateSync(bytes) : bytes;
  const modified = new Set<string>();
  const put = (path: string, data: Uint8Array): void => { CFB.utils.cfb_add(source, '/' + path, data); modified.add(path); };

  // rhwp keeps old resource IDs. Check that invariant against its unmodified
  // export before grafting appended resources into the original DocInfo.
  const oldInfo = records(decode(read(source, 'DocInfo')));
  const baseInfo = records(genDecode(read(baseline, 'DocInfo')));
  const newInfo = records(genDecode(read(edited, 'DocInfo')));
  const appends: RecordData[] = [];
  for (const tag of new Set(newInfo.map(r => r.tag))) {
    if (tag === 16 || tag === 17) continue;
    const before = baseInfo.filter(r => r.tag === tag), after = newInfo.filter(r => r.tag === tag);
    if (oldInfo.filter(r => r.tag === tag).length !== before.length || after.length < before.length || before.some((r, i) => !equal(r.raw, after[i].raw))) throw new Error('원본 리소스 ID 보존 검사에 실패했습니다.');
    appends.push(...after.slice(before.length));
  }
  if (appends.length) {
    const mapping = oldInfo.find(r => r.tag === 17)!;
    const baseMapping = baseInfo.find(r => r.tag === 17)!, newMapping = newInfo.find(r => r.tag === 17)!;
    const data = mapping.data.slice();
    if (data.length !== baseMapping.data.length || data.length !== newMapping.data.length) throw new Error('HWP 리소스 매핑 형식이 다릅니다.');
    for (let offset = 0; offset < data.length; offset += 4) {
      const delta = view(newMapping.data).getUint32(offset, true) - view(baseMapping.data).getUint32(offset, true);
      if (delta < 0) throw new Error('원본 리소스 매핑이 감소했습니다.');
      view(data).setUint32(offset, view(data).getUint32(offset, true) + delta, true);
    }
    const combined = oldInfo.map(r => r === mapping ? encode({ ...r, data }) : r.raw);
    combined.push(...appends.map(r => r.raw));
    put('DocInfo', pack(join(combined)));
  }
  for (let index = 0; index < edited.FileIndex.length; index++) {
    const path = edited.FullPaths[index].replace(/^[^/]+\//, '');
    if (path.startsWith('BinData/') && edited.FileIndex[index].type === 2 && !CFB.find(source, '/' + path)) put(path, new Uint8Array(edited.FileIndex[index].content));
  }
  for (const section of new Set(added.map(a => a.section))) {
    const path = `BodyText/Section${section}`;
    const oldRecords = records(decode(read(source, path)));
    const genRecords = records(genDecode(read(edited, path)));
    type Target = { start: number; end: number; level: number; extra: RecordData[]; preserveText: boolean };
    const targets = new Map<number, Target>();
    const spanEnd = (start: number, limit = oldRecords.length): number => {
      let end = start + 1;
      while (end < limit && oldRecords[end].level > oldRecords[start].level) end++;
      return end;
    };
    const paragraphAt = (start: number, end: number, level: number, ordinal: number): number => {
      const found = oldRecords.flatMap((r, i) => i >= start && i < end && r.tag === 66 && r.level === level ? [i] : []);
      if (found[ordinal] === undefined) throw new Error('원본 문단 위치를 찾을 수 없습니다.');
      return found[ordinal];
    };
    const locate = (control: AddedControl): number => {
      let paragraph = paragraphAt(0, oldRecords.length, 0, control.paragraph);
      for (const step of control.cellPath ?? []) {
        const end = spanEnd(paragraph), level = oldRecords[paragraph].level;
        const controls = oldRecords.flatMap((r, i) => i > paragraph && i < end && r.tag === 71 && r.level === level + 1 ? [i] : []);
        const parent = controls[step.controlIndex];
        if (parent === undefined || view(oldRecords[parent].data).getUint32(0, true) !== 0x74626c20) throw new Error('중첩 표 연결 위치를 확인할 수 없습니다.');
        const controlEnd = spanEnd(parent, end), childLevel = level + 2;
        const table = oldRecords.findIndex((r, i) => i > parent && i < controlEnd && r.tag === 77 && r.level === childLevel);
        if (table < 0) throw new Error('원본 표 기록이 없습니다.');
        const cells = oldRecords.flatMap((r, i) => i > table && i < controlEnd && r.tag === 72 && r.level === childLevel ? [i] : []);
        const cell = cells[step.cellIndex];
        if (cell === undefined) throw new Error('원본 셀 위치를 찾을 수 없습니다.');
        paragraph = paragraphAt(cell + 1, cells[step.cellIndex + 1] ?? controlEnd, childLevel, step.cellParaIndex);
      }
      return paragraph;
    };
    for (const control of added.filter(a => a.section === section)) {
      const token = new Uint8Array([...control.token].flatMap(c => [c.charCodeAt(0) & 255, c.charCodeAt(0) >>> 8]));
      const matches = genRecords.flatMap((r, i) => r.tag === 71 && r.level === 1 && r.data.length >= 40 && view(r.data).getUint32(0, true) === 0x67736f20 && r.data.some((_, offset) => equal(r.data.subarray(offset, offset + token.length), token)) ? [i] : []);
      if (matches.length !== 1) throw new Error(`추가한 개체의 고유 식별자를 확인할 수 없습니다. (${control.token}, ${matches.length})`);
      const start = matches[0] ?? -1;
      if (start < 0 || view(genRecords[start].data).getUint32(0, true) !== 0x67736f20) throw new Error('추가한 HWP 개체를 찾을 수 없습니다.');
      let end = start + 1; while (end < genRecords.length && genRecords[end].level > 1) end++;
      const at = locate(control);
      const target = targets.get(at) ?? { start: at, end: spanEnd(at), level: oldRecords[at].level, extra: [], preserveText: !!control.preserveText };
      target.extra.push(...genRecords.slice(start, end));
      targets.set(at, target);
    }
    const overrides = new Map<number, Uint8Array>();
    const insertAt = new Map<number, Target[]>();
    for (const target of targets.values()) {
      const { start, end, level, extra, preserveText } = target;
      const record = oldRecords[start];
      const textIndex = oldRecords.findIndex((r, i) => i > start && i < end && r.tag === 67 && r.level === level + 1);
      const hasText = textIndex >= 0;
      const count = extra.filter(r => r.tag === 71 && r.level === 1).length;
      const data = record.data.slice();
      if (hasText && !preserveText) {
        const rawCount = view(data).getUint32(0, true);
        view(data).setUint32(0, ((rawCount & 0x7fffffff) + count * 8) | (rawCount & 0x80000000), true);
      }
      view(data).setUint32(4, view(data).getUint32(4, true) | 0x800, true);
      overrides.set(start, encode({ ...record, data }));
      // Explicit text keeps all existing offsets: append only new GSO markers
      // before the paragraph end. Implicit table-only hosts retain the native
      // floating-picture sibling representation, without synthetic text.
      if (hasText && !preserveText) {
          const child = oldRecords[textIndex];
          if (child.data.length < 2 || view(child.data).getUint16(child.data.length - 2, true) !== 13) throw new Error('HWP 문단 끝 형식이 다릅니다.');
          const marker = new Uint8Array([11, 0, 32, 111, 115, 103, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0]);
          overrides.set(textIndex, encode({ ...child, data: join([child.data.slice(0, -2), ...Array.from({ length: count }, () => marker), child.data.slice(-2)]) }));
      }
      const list = insertAt.get(end) ?? []; list.push(target); insertAt.set(end, list);
    }
    const output: Uint8Array[] = [];
    for (let index = 0; index <= oldRecords.length; index++) {
      // Close nested paragraph additions before additions to an ancestor.
      for (const target of (insertAt.get(index) ?? []).sort((a, b) => b.level - a.level)) output.push(...target.extra.map(r => target.level ? encode({ ...r, level: r.level + target.level }) : r.raw));
      if (index < oldRecords.length) output.push(overrides.get(index) ?? oldRecords[index].raw);
    }
    put(path, pack(join(output)));
  }
  const bytes = new Uint8Array(CFB.write(source, { type: 'array', fileType: 'cfb' }));
  normalizeCfbAllocation(bytes);
  const reopened = CFB.read(bytes, { type: 'array' });
  // Assert byte preservation for every unmodified original stream, including
  // unknown records, embedded files, preview, scripts and metadata.
  const input = CFB.read(original, { type: 'array' });
  input.FileIndex.forEach((entry, i) => {
    const path = input.FullPaths[i].replace(/^[^/]+\//, '');
    if (entry.type === 2 && !modified.has(path) && !equal(new Uint8Array(entry.content), read(reopened, path))) throw new Error(`원본 스트림 보존 실패: ${path}`);
  });
  return bytes;
}
