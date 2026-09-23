import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export class PdfInkViewer {
  constructor({ pdfCanvas, inkCanvas, frame, stage }) {
    this.pdfCanvas = pdfCanvas;
    this.inkCanvas = inkCanvas;
    this.frame = frame;
    this.stage = stage;
    this.pdf = null;
    this.pageNumber = 1;
    this.renderTask = null;
    this.strokes = new Map();
    this.liveStrokes = new Map();
    this.resizeTimer = 0;
    this.view = { scale: 1, x: 0.5, y: 0.5 };
    this.onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => { if (this.pdf) this.renderPage(this.pageNumber, true); }, 120);
    };
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  async load(url, httpHeaders = undefined) {
    this.pdf = await pdfjsLib.getDocument({ url, httpHeaders }).promise;
    this.pageNumber = Math.min(Math.max(this.pageNumber, 1), this.pdf.numPages);
    await this.renderPage(this.pageNumber);
    return this.pdf.numPages;
  }

  async renderPage(pageNumber, preserveView = false) {
    if (!this.pdf) return;
    this.pageNumber = Math.min(Math.max(Number(pageNumber) || 1, 1), this.pdf.numPages);
    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch { /* ignore */ }
    }
    const page = await this.pdf.getPage(this.pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    const available = Math.max(280, this.stage.clientWidth - 8);
    const cssScale = Math.min(2, available / unscaled.width) * this.view.scale;
    const viewport = page.getViewport({ scale: cssScale });
    const dpr = Math.max(.5, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height))));
    this.renderDpr = dpr;

    this.frame.style.width = `${viewport.width}px`;
    this.frame.style.height = `${viewport.height}px`;
    this.pdfCanvas.style.width = `${viewport.width}px`;
    this.pdfCanvas.style.height = `${viewport.height}px`;
    this.pdfCanvas.width = Math.floor(viewport.width * dpr);
    this.pdfCanvas.height = Math.floor(viewport.height * dpr);

    const ctx = this.pdfCanvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderTask = page.render({ canvasContext: ctx, viewport });
    await this.renderTask.promise.catch((error) => {
      if (error?.name !== 'RenderingCancelledException') throw error;
    });

    this.inkCanvas.style.width = `${viewport.width}px`;
    this.inkCanvas.style.height = `${viewport.height}px`;
    this.inkCanvas.width = Math.floor(viewport.width * dpr);
    this.inkCanvas.height = Math.floor(viewport.height * dpr);
    this.redraw();
    if (preserveView || this.view.scale > 1) this.applyCenter();
  }

  async setView(view, rerender = true) {
    const next = {
      scale: Math.min(4, Math.max(1, Number(view?.scale) || 1)),
      x: Math.min(1, Math.max(0, Number(view?.x) || 0.5)),
      y: Math.min(1, Math.max(0, Number(view?.y) || 0.5)),
    };
    const scaleChanged = Math.abs(next.scale - this.view.scale) > 0.001;
    this.view = next;
    if (rerender && this.pdf && scaleChanged) await this.renderPage(this.pageNumber, true);
    else this.applyCenter();
    return this.getView();
  }

  getView() {
    if (this.stage.scrollWidth > this.stage.clientWidth) this.view.x = (this.stage.scrollLeft + this.stage.clientWidth / 2) / this.stage.scrollWidth;
    if (this.stage.scrollHeight > this.stage.clientHeight) this.view.y = (this.stage.scrollTop + this.stage.clientHeight / 2) / this.stage.scrollHeight;
    return { scale: this.view.scale, x:Math.min(1,Math.max(0,this.view.x)), y:Math.min(1,Math.max(0,this.view.y)) };
  }

  applyCenter() {
    requestAnimationFrame(() => {
      const maxX = Math.max(0, this.stage.scrollWidth - this.stage.clientWidth);
      const maxY = Math.max(0, this.stage.scrollHeight - this.stage.clientHeight);
      this.stage.scrollLeft = Math.min(maxX, Math.max(0, this.view.x * this.stage.scrollWidth - this.stage.clientWidth / 2));
      this.stage.scrollTop = Math.min(maxY, Math.max(0, this.view.y * this.stage.scrollHeight - this.stage.clientHeight / 2));
    });
  }

  setPageStrokes(page, strokes = []) {
    this.strokes.set(Number(page), structuredClone(strokes));
    if (Number(page) === this.pageNumber) this.redraw();
  }

  addStroke(page, stroke) {
    const key = Number(page);
    const list = this.strokes.get(key) || [];
    const existing = list.findIndex((item) => item.id === stroke.id);
    if (existing >= 0) list[existing] = structuredClone(stroke);
    else list.push(structuredClone(stroke));
    this.strokes.set(key, list);
    this.liveStrokes.delete(stroke.id);
    if (key === this.pageNumber) this.redraw();
  }

  removeStroke(page, id) {
    const key = Number(page);
    const list = (this.strokes.get(key) || []).filter((s) => s.id !== id);
    this.strokes.set(key, list);
    this.liveStrokes.delete(id);
    if (key === this.pageNumber) this.redraw();
  }

  clearPage(page) {
    this.strokes.set(Number(page), []);
    if (Number(page) === this.pageNumber) this.redraw();
  }

  startLiveStroke(stroke) {
    this.liveStrokes.set(stroke.id, structuredClone(stroke));
    if (Number(stroke.page) === this.pageNumber) this.redraw();
  }

  appendLivePoints(id, points) {
    const stroke = this.liveStrokes.get(id);
    if (!stroke) return;
    stroke.points.push(...points);
    if (Number(stroke.page) === this.pageNumber) this.redraw();
  }

  updateLiveStroke(id, points) {
    const stroke = this.liveStrokes.get(id);
    if (!stroke) return;
    stroke.points = [...points];
    if (Number(stroke.page) === this.pageNumber) this.redraw();
  }

  finishLiveStroke(id) {
    this.liveStrokes.delete(id);
    this.redraw();
  }

  getPageStrokes(page = this.pageNumber) { return this.strokes.get(Number(page)) || []; }

  hitTest(x, y, threshold = 0.025) {
    const list = [...this.getPageStrokes()].reverse();
    for (const stroke of list) {
      const pts = stroke.points || [];
      for (let i = 0; i < pts.length; i += 3) {
        const dx = pts[i] - x, dy = pts[i + 1] - y;
        if ((dx * dx + dy * dy) <= threshold * threshold) return stroke.id;
      }
    }
    return null;
  }

  pointerToNormalized(event) {
    const rect = this.inkCanvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      p: Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  redraw() {
    const ctx = this.inkCanvas.getContext('2d');
    const dpr = this.renderDpr || Math.min(window.devicePixelRatio || 1, 2);
    const width = this.inkCanvas.width / dpr;
    const height = this.inkCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const strokes = [
      ...(this.strokes.get(this.pageNumber) || []),
      ...[...this.liveStrokes.values()].filter((s) => Number(s.page) === this.pageNumber),
    ];
    for (const stroke of strokes) this.drawStroke(ctx, stroke, width, height);
  }

  drawStroke(ctx, stroke, width, height) {
    const pts = stroke.points || [];
    if (pts.length < 3) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity ?? 1;
    ctx.strokeStyle = stroke.color || '#e53935';
    ctx.lineWidth = Math.max(1.5, (stroke.width || 0.004) * Math.min(width, height));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    if (stroke.tool === 'rect' && pts.length >= 6) {
      const x=pts[0]*width, y=pts[1]*height, w=pts[3]*width-x, h=pts[4]*height-y;
      ctx.strokeRect(x,y,w,h); ctx.restore(); return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0] * width, pts[1] * height);
    for (let i = 3; i < pts.length; i += 3) ctx.lineTo(pts[i] * width, pts[i + 1] * height);
    if (pts.length === 3) ctx.lineTo(pts[0] * width + .1, pts[1] * height + .1);
    ctx.stroke();
    ctx.restore();
  }

  destroy() { window.removeEventListener('resize', this.onResize); }
}
