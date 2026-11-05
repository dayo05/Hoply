import { inside, layoutText, validateEdits, type EditItem, type EditPoint, type EditRect, type EditState } from './simple-edit-model';

const NS = 'http://www.w3.org/2000/svg';
const newId = (): string => [...crypto.getRandomValues(new Uint32Array(4))].map(v => v.toString(16)).join('-');
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

export class SimpleEdit {
  private state: EditState = { schema: 1, items: [] };
  private undoStack: EditState[] = [];
  private redoStack: EditState[] = [];
  private pages = new Map<number, { base: SVGSVGElement; layer: SVGSVGElement }>();
  private enabled = false;
  private tool = 'move';
  private fingerDrawing = false;
  private toolbar = document.createElement('div');
  private message = document.createElement('span');
  private dialog = document.createElement('dialog');
  private pointer: { id: number; page: number; start: EditPoint; points: EditPoint[]; node: SVGElement } | null = null;

  constructor(private changed: (state: EditState) => void) {
    this.toolbar.className = 'edit-toolbar';
    this.toolbar.hidden = true;
    this.toolbar.setAttribute('aria-label', 'Simple Edit 도구');
    for (const [tool, title] of [['move', '이동'], ['text', '텍스트'], ['pen', '펜'], ['finger', '손가락'], ['erase', '지우개'], ['undo', '취소'], ['redo', '다시']]) {
      const button = document.createElement('button');
      button.textContent = title;
      button.dataset.tool = tool;
      button.type = 'button';
      button.addEventListener('click', () => {
        if (tool === 'undo' || tool === 'redo') this.history(tool === 'undo');
        else if (tool === 'finger') { this.cancelPointer(); this.fingerDrawing = !this.fingerDrawing; this.tool = 'pen'; this.updateTools(); }
        else { this.cancelPointer(); this.tool = tool; this.updateTools(); }
      });
      this.toolbar.append(button);
    }
    this.message.className = 'edit-hint';
    this.message.setAttribute('role', 'status');
    this.toolbar.append(this.message);
    document.querySelector('#viewer-shell')!.prepend(this.toolbar);
    this.dialog.className = 'edit-dialog';
    this.dialog.addEventListener('cancel', () => this.dialog.close());
    document.body.append(this.dialog);
  }

  load(value: unknown, count: number): void {
    this.state = validateEdits(value, count);
    this.undoStack = []; this.redoStack = [];
    this.render();
  }

  snapshot(): EditState { return structuredClone(this.state); }
  isBusy(): boolean { return this.dialog.open || this.pointer !== null; }

  setEnabled(enabled: boolean): boolean {
    if (this.isBusy()) return false;
    this.enabled = enabled;
    this.toolbar.hidden = !enabled;
    this.tool = 'move';
    this.updateTools();
    return true;
  }

  setStatus(message: string): void { this.message.textContent = message; }

  mount(page: HTMLElement, base: SVGSVGElement, index: number): void {
    const layer = svg('svg', { viewBox: base.getAttribute('viewBox')!, 'aria-label': '입력과 서명' });
    layer.classList.add('edit-layer');
    page.append(layer);
    this.pages.set(index, { base, layer });
    layer.addEventListener('pointerdown', e => this.down(e, index));
    layer.addEventListener('pointermove', e => this.move(e));
    layer.addEventListener('pointerup', e => this.up(e));
    layer.addEventListener('pointercancel', () => this.cancelPointer());
    this.renderPage(index);
    this.updateTools();
  }

  private updateTools(): void {
    for (const button of this.toolbar.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === 'finger' ? this.fingerDrawing : button.dataset.tool === this.tool));
      if (button.dataset.tool === 'undo') button.disabled = this.undoStack.length === 0;
      if (button.dataset.tool === 'redo') button.disabled = this.redoStack.length === 0;
    }
    this.setStatus(this.tool === 'text' ? '빈 셀을 탭하거나 입력할 영역을 드래그하세요.' : this.tool === 'pen' ? this.fingerDrawing ? '손가락으로 쓰기 · 스크롤하려면 이동을 누르세요.' : 'Apple Pencil로 쓰세요. 손가락으로는 이동합니다.' : this.tool === 'erase' ? '추가한 글자나 필기를 탭해 지웁니다.' : '원본 서식 고정 · 입력과 서명만 편집');
    for (const { layer } of this.pages.values()) {
      layer.style.pointerEvents = this.enabled && this.tool !== 'move' ? 'auto' : 'none';
      // Touch scrolling remains available for palm/finger input in Pencil mode.
      layer.style.touchAction = this.tool === 'pen' && !this.fingerDrawing ? 'pan-x pan-y pinch-zoom' : this.tool === 'text' || this.tool === 'pen' ? 'none' : 'auto';
    }
  }

  private point(event: PointerEvent, page: number): EditPoint {
    const layer = this.pages.get(page)!.layer;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(layer.getScreenCTM()!.inverse());
    const box = layer.viewBox.baseVal;
    return { x: Math.max(0, Math.min(box.width, p.x)), y: Math.max(0, Math.min(box.height, p.y)), pressure: event.pressure || 0.5 };
  }

  private down(event: PointerEvent, page: number): void {
    if (!this.enabled || this.pointer || this.dialog.open || this.tool === 'move' || (this.tool === 'pen' && event.pointerType === 'touch' && !this.fingerDrawing)) return;
    const start = this.point(event, page);
    const found = [...this.state.items].reverse().find(item => item.page === page && inside(item.rect, start));
    if (this.tool === 'erase') {
      if (found) this.commit(this.state.items.filter(item => item.id !== found.id));
      return;
    }
    if (this.tool === 'text' && found?.kind === 'text') { this.editText(page, found.rect, found); return; }
    const layer = this.pages.get(page)!.layer;
    const node = this.tool === 'pen' ? svg('polyline', { fill: 'none', stroke: '#17202a', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) : svg('rect', { fill: '#b69ae333', stroke: '#8057bb' });
    layer.append(node);
    this.pointer = { id: event.pointerId, page, start, points: [start], node };
    layer.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private move(event: PointerEvent): void {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = this.point(event, pointer.page);
    if (this.tool === 'pen') {
      pointer.points.push(point);
      pointer.node.setAttribute('points', pointer.points.map(p => `${p.x},${p.y}`).join(' '));
    } else {
      const rect = this.dragRect(pointer.start, point);
      for (const [key, value] of Object.entries(rect)) pointer.node.setAttribute(key, String(value));
    }
    event.preventDefault();
  }

  private up(event: PointerEvent): void {
    const p = this.pointer;
    if (!p || p.id !== event.pointerId) return;
    this.move(event);
    this.pointer = null; p.node.remove();
    if (this.tool === 'pen') {
      const xs = p.points.map(v => v.x), ys = p.points.map(v => v.y);
      const rect = { x: Math.max(0, Math.min(...xs) - 2), y: Math.max(0, Math.min(...ys) - 2), width: Math.max(...xs) - Math.min(...xs) + 4, height: Math.max(...ys) - Math.min(...ys) + 4 };
      this.commit([...this.state.items, { kind: 'ink', id: newId(), page: p.page, rect, color: '#17202a', points: p.points, width: 2 }]);
    } else {
      let rect = this.dragRect(p.start, this.point(event, p.page));
      if (rect.width < 10 || rect.height < 10) {
        const cell = this.cellAt(p.page, p.start);
        if (!cell) { this.setStatus('입력할 셀을 탭하거나 영역을 드래그해 주세요.'); return; }
        rect = cell;
      }
      this.editText(p.page, rect);
    }
  }

  private dragRect(a: EditPoint, b: EditPoint): EditRect { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }
  private cancelPointer(): void { this.pointer?.node.remove(); this.pointer = null; }

  private cellAt(page: number, point: EditPoint): EditRect | undefined {
    const base = this.pages.get(page)!.base;
    // A clip rectangle is only a convenience target; never edit the underlying cell.
    const cells = [...base.querySelectorAll<SVGRectElement>('clipPath[id*="cell-clip-"] > rect')].map(r => ({ x: r.x.baseVal.value, y: r.y.baseVal.value, width: r.width.baseVal.value, height: r.height.baseVal.value }));
    return cells.filter(r => inside(r, point)).sort((a, b) => a.width * a.height - b.width * b.height)[0];
  }

  private editText(page: number, rect: EditRect, existing?: EditItem & { kind: 'text' }): void {
    this.dialog.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = '고정 영역에 입력';
    const input = document.createElement('textarea'); input.value = existing?.text ?? ''; input.rows = 4; input.maxLength = 10000; input.setAttribute('aria-label', '입력할 내용');
    const label = document.createElement('label'); label.textContent = '글자 크기 ';
    const size = document.createElement('input'); size.type = 'number'; size.min = '6'; size.max = '72'; size.value = String(existing?.fontSize ?? 13); size.setAttribute('aria-label', '글자 크기'); label.append(size);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const apply = document.createElement('button'); apply.textContent = '적용';
    const cancel = document.createElement('button'); cancel.textContent = '취소'; cancel.onclick = () => this.dialog.close();
    const context = document.createElement('canvas').getContext('2d')!;
    const check = (): string[] | null => {
      const fontSize = Number(size.value);
      context.font = `${fontSize}px sans-serif`;
      const lines = fontSize >= 6 && fontSize <= 72 ? layoutText(input.value, rect, fontSize, text => context.measureText(text).width) : null;
      apply.disabled = !lines;
      status.textContent = lines ? '영역 크기는 고정됩니다. 기존 글자는 그대로 유지됩니다.' : '영역을 넘습니다. 내용을 줄이거나 글자 크기를 낮춰 주세요.';
      return lines;
    };
    input.oninput = check; size.oninput = check;
    apply.onclick = () => {
      if (!check()) return;
      const remaining = this.state.items.filter(i => i.id !== existing?.id);
      if (input.value) remaining.push({ id: existing?.id ?? newId(), page, rect, kind: 'text', text: input.value, fontSize: Number(size.value), color: '#17202a' });
      this.commit(remaining); this.dialog.close();
    };
    this.dialog.append(heading, input, label, status, cancel, apply);
    check(); this.dialog.showModal(); input.focus();
  }

  private commit(items: EditItem[]): void {
    this.undoStack.push(this.snapshot()); this.undoStack = this.undoStack.slice(-50); this.redoStack = [];
    this.state = { schema: 1, items }; this.render(); this.changed(this.snapshot());
  }
  private history(undo: boolean): void {
    const from = undo ? this.undoStack : this.redoStack, to = undo ? this.redoStack : this.undoStack;
    const state = from.pop(); if (!state) return;
    to.push(this.snapshot()); this.state = state; this.render(); this.changed(this.snapshot());
  }
  private render(): void { for (const index of this.pages.keys()) this.renderPage(index); this.updateTools(); }
  private renderPage(index: number): void {
    const layer = this.pages.get(index)!.layer;
    layer.replaceChildren();
    for (const item of this.state.items.filter(i => i.page === index)) {
      if (item.kind === 'ink') {
        layer.append(svg('polyline', { points: item.points.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: item.color, 'stroke-width': item.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      } else {
        const context = document.createElement('canvas').getContext('2d')!;
        context.font = `${item.fontSize}px sans-serif`;
        const lines = layoutText(item.text, item.rect, item.fontSize, s => context.measureText(s).width);
        const group = svg('svg', { x: item.rect.x, y: item.rect.y, width: item.rect.width, height: item.rect.height, overflow: 'hidden' });
        (lines ?? []).forEach((line, i) => { const node = svg('text', { x: 4, y: 4 + item.fontSize + i * item.fontSize * 1.3, fill: item.color, 'font-size': item.fontSize, 'font-family': 'sans-serif' }); node.textContent = line; group.append(node); });
        layer.append(group);
      }
    }
  }
}
