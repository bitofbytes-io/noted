import {
  GlobalWorkerOptions,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  getDocument,
} from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export interface PageMetric {
  page: number;
  ratio: number;
}

interface ActiveRender {
  key: string;
  promise: Promise<void>;
  task?: RenderTask;
}

export class PdfDocument {
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private documentGeneration = 0;
  private readonly renders = new Map<HTMLCanvasElement, ActiveRender>();

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  async load(url: string): Promise<PageMetric[]> {
    await this.dispose();
    this.loadingTask = getDocument({ url, wasmUrl: '/pdfjs/wasm/' });
    this.document = await this.loadingTask.promise;
    const metrics: PageMetric[] = [];
    for (let pageNumber = 1; pageNumber <= this.document.numPages; pageNumber += 1) {
      const page = await this.document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      metrics.push({ page: pageNumber, ratio: viewport.width / viewport.height });
      page.cleanup();
    }
    return metrics;
  }

  /**
   * Draws a page into the canvas. An identical request for the same canvas while one is
   * in flight shares that render; only a different requested output cancels it.
   */
  renderPage(
    canvas: HTMLCanvasElement,
    pageNumber: number,
    cssWidth: number,
    maximumCssHeight?: number,
  ): Promise<void> {
    const document = this.document;
    if (!document || cssWidth <= 0) return Promise.resolve();
    const key = `${this.documentGeneration}:${pageNumber}:${cssWidth}:${maximumCssHeight ?? ''}`;
    const active = this.renders.get(canvas);
    if (active?.key === key) return active.promise;
    active?.task?.cancel();
    const render: ActiveRender = { key, promise: Promise.resolve() };
    this.renders.set(canvas, render);
    render.promise = this.draw(document, render, canvas, pageNumber, cssWidth, maximumCssHeight);
    return render.promise;
  }

  private async draw(
    document: PDFDocumentProxy,
    render: ActiveRender,
    canvas: HTMLCanvasElement,
    pageNumber: number,
    cssWidth: number,
    maximumCssHeight?: number,
  ): Promise<void> {
    try {
      const page = await document.getPage(pageNumber);
      try {
        // A different request for this canvas superseded this one before drawing began.
        if (this.renders.get(canvas) !== render) return;
        const base = page.getViewport({ scale: 1 });
        let scale = cssWidth / base.width;
        if (maximumCssHeight) scale = Math.min(scale, maximumCssHeight / base.height);
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is unavailable.');
        render.task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await render.task.promise;
      } finally {
        page.cleanup();
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
    } finally {
      if (this.renders.get(canvas) === render) this.renders.delete(canvas);
    }
  }

  async dispose(): Promise<void> {
    this.documentGeneration += 1;
    for (const render of this.renders.values()) render.task?.cancel();
    this.renders.clear();
    if (this.loadingTask) await this.loadingTask.destroy();
    this.loadingTask = undefined;
    this.document = undefined;
  }
}
