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

export class PdfDocument {
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private readonly renderTasks = new Map<HTMLCanvasElement, RenderTask>();

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

  async renderPage(
    canvas: HTMLCanvasElement,
    pageNumber: number,
    cssWidth: number,
    maximumCssHeight?: number,
  ): Promise<void> {
    if (!this.document || cssWidth <= 0) return;
    const previous = this.renderTasks.get(canvas);
    if (previous) {
      previous.cancel();
      this.renderTasks.delete(canvas);
    }
    const page = await this.document.getPage(pageNumber);
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
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    this.renderTasks.set(canvas, task);
    try {
      await task.promise;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
    } finally {
      if (this.renderTasks.get(canvas) === task) this.renderTasks.delete(canvas);
      page.cleanup();
    }
  }

  async dispose(): Promise<void> {
    for (const task of this.renderTasks.values()) task.cancel();
    this.renderTasks.clear();
    if (this.loadingTask) await this.loadingTask.destroy();
    this.loadingTask = undefined;
    this.document = undefined;
  }
}
