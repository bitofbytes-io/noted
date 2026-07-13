import {
  GlobalWorkerOptions,
  getDocument,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export type PdfFitMode = 'width' | 'page';

export class PdfScoreAdapter {
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private renderTask?: RenderTask;

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  async load(url: string): Promise<number> {
    await this.dispose();
    this.loadingTask = getDocument({ url });
    this.document = await this.loadingTask.promise;
    return this.document.numPages;
  }

  async render(
    canvas: HTMLCanvasElement,
    pageNumber: number,
    mode: PdfFitMode,
    availableWidth: number,
    availableHeight: number,
  ): Promise<void> {
    if (!this.document) throw new Error('PDF is not loaded');
    const page: PDFPageProxy = await this.document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const widthScale = Math.max(0.25, (availableWidth - 28) / base.width);
    const heightScale = Math.max(0.25, (availableHeight - 28) / base.height);
    const scale = mode === 'width' ? widthScale : Math.min(widthScale, heightScale);
    const viewport = page.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable');
    await this.renderTask?.cancel();
    this.renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    await this.renderTask.promise;
  }

  async dispose(): Promise<void> {
    this.renderTask?.cancel();
    this.renderTask = undefined;
    if (this.loadingTask) await this.loadingTask.destroy();
    this.loadingTask = undefined;
    this.document = undefined;
  }
}
